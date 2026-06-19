"""FastAPI application — wires modules, event bus, static web build."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import HTTPConnection

from warlock import __version__
from warlock.api import aar as aar_api
from warlock.api import engagements as engagements_api
from warlock.api import health as health_api
from warlock.api import ws as ws_api
from warlock.auth import check_basic_auth
from warlock.config import get_settings
from warlock.db import init_db
from warlock.registry import load_modules

log = logging.getLogger("warlock.server")

_settings = get_settings()

# Paths that bypass HTTP basic auth — health endpoints and the WS bus
# (WS subscription is protected at the app level via a token for now; TODO).
_UNAUTHED_PATHS: set[str] = {"/api/health", "/api/version", "/ws"}


def _check_auth(conn: HTTPConnection) -> None:
    """Verify HTTP Basic credentials on every HTTP request.

    Uses ``HTTPConnection`` (base of Request+WebSocket) so the dependency is
    safely attachable to routers that also contain WebSocket endpoints.
    WebSocket scopes are authenticated per-socket inside ``api.ws`` (the same
    Basic credential is validated on the upgrade handshake), so they bypass this
    HTTP dependency. Credential checking is delegated to ``warlock.auth`` so the
    HTTP and WS surfaces share one implementation.
    """
    if conn.url.path in _UNAUTHED_PATHS or conn.url.path.startswith("/ws/"):
        return
    # DID documents are public by design — did:web resolvers must fetch them
    # without credentials.
    if conn.url.path.endswith("/.well-known/did.json"):
        return
    if conn.scope.get("type") == "websocket":
        return
    if check_basic_auth(conn.headers.get("authorization")):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="auth required",
        headers={"WWW-Authenticate": "Basic"},
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("warlock v%s starting on %s:%s", __version__, _settings.host, _settings.port)
    if not _settings.web_password:
        log.warning(
            "WARLOCK_WEB_PASSWORD is empty — HTTP Basic auth is DISABLED; ALL /api and "
            "/ws endpoints are OPEN on %s:%s. Set WARLOCK_WEB_PASSWORD to require auth.",
            _settings.host,
            _settings.port,
        )
    # Dispatch module startup hooks if defined.
    for m in app.state.modules:
        if hasattr(m, "on_startup"):
            try:
                await m.on_startup()
            except Exception:  # noqa: BLE001
                log.exception("module %s startup failed", m.id)

    # Engagement auto-expiry watchdog.
    async def _engagement_expiry_loop(eng):
        """Check every 60s if the active engagement has passed its planned_end.
        If so, end it gracefully (audit + AAR + scope clear). This enforces the
        duration_hours the operator declared when arming — no engagement stays
        live past its stated window."""
        while True:
            await asyncio.sleep(60)
            try:
                if engagement.is_expired():
                    eid = engagement.engagement_id
                    name = engagement.name
                    log.warning(
                        "engagement %s (%s) expired — auto-ending (planned_end=%s)",
                        eid, name, engagement.planned_end,
                    )
                    await engagement.end()
                    from warlock.db import session_scope
                    from warlock.models import Engagement as EngModel
                    from datetime import datetime as _dt
                    with session_scope() as s:
                        row = s.get(EngModel, eid)
                        if row is not None:
                            row.status = "ended"
                            row.ended_at = _dt.utcnow()
            except Exception:  # noqa: BLE001 — watchdog must never die
                log.exception("engagement expiry watchdog error (non-fatal)")

    import asyncio as _aio
    from warlock.engagement import engagement as _eng
    expiry_task = _aio.create_task(_engagement_expiry_loop(_eng))

    yield

    expiry_task.cancel()
    for m in app.state.modules:
        if hasattr(m, "on_shutdown"):
            try:
                await m.on_shutdown()
            except Exception:  # noqa: BLE001
                log.exception("module %s shutdown failed", m.id)
    # Cancel any lingering jobs.
    from warlock.jobs import runner

    await runner.cancel_all()


def create_app() -> FastAPI:
    app = FastAPI(title="Warlock", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Core API routers.
    app.include_router(health_api.router, dependencies=[Depends(_check_auth)])
    app.include_router(engagements_api.router, dependencies=[Depends(_check_auth)])
    # GET /api/ws-token is Basic-auth-gated (mints the browser's /ws token);
    # the /ws upgrade itself authenticates per-socket (Basic header OR ?token=).
    app.include_router(ws_api.token_router, dependencies=[Depends(_check_auth)])
    app.include_router(ws_api.router)  # auth handled per-socket
    # AAR read API (records / preimage custody / did.json) — Basic-auth gated.
    app.include_router(aar_api.router, dependencies=[Depends(_check_auth)])

    # Module routers.
    modules = load_modules()
    for m in modules:
        app.include_router(m.router(), dependencies=[Depends(_check_auth)])
    app.state.modules = modules

    # /api/modules — TUI + web uses this to render the nav.
    @app.get("/api/modules", dependencies=[Depends(_check_auth)])
    def modules_list() -> list[dict]:
        return [
            {
                "id": m.id,
                "label": m.label,
                "icon": m.icon,
                "requires_engagement": m.requires_engagement,
                "requires_root": m.requires_root,
            }
            for m in modules
        ]

    # --- DID document endpoints (public, no auth) ---
    # did:web resolves by fetching /.well-known/did.json (bare) or
    # /<path>/.well-known/did.json (path-suffixed). We serve both so the
    # deck's public key is reachable regardless of DID shape.
    from warlock.aar.did import deck_did_document

    @app.get("/.well-known/did.json")
    def well_known_did() -> JSONResponse:
        return JSONResponse(deck_did_document())

    @app.get("/{deck_id}/.well-known/did.json")
    def well_known_did_deck(deck_id: str) -> JSONResponse:
        """Path-suffixed DID resolution (did:web:host:deck-id).

        Only serves the document when deck_id matches the configured DID path
        segment — a random path should NOT leak the deck's public key."""
        subject = _settings.aar_subject_did
        # Extract the last colon-separated segment from the DID.
        parts = subject.split(":")
        if len(parts) < 4:
            if deck_id == "well-known":
                raise HTTPException(404)
            return JSONResponse(deck_did_document())
        expected = parts[-1]  # e.g. "warlock-cm5-01"
        if deck_id != expected:
            raise HTTPException(status_code=404, detail="unknown deck")
        return JSONResponse(deck_did_document())

    # Static web build.
    web_dist: Path = _settings.web_dist
    if web_dist.exists() and (web_dist / "index.html").exists():
        app.mount("/web", StaticFiles(directory=str(web_dist), html=True), name="web")

        @app.get("/", response_class=HTMLResponse)
        def root() -> HTMLResponse:
            return HTMLResponse((web_dist / "index.html").read_text())

        # SPA fallback — serve index.html for any client-side route the SPA owns.
        # Excludes /api/*, /ws/*, /web/* (those have their own handlers/mounts).
        @app.get("/{full_path:path}", response_class=HTMLResponse)
        def spa_fallback(full_path: str) -> HTMLResponse:
            if (
                full_path.startswith("api/")
                or full_path.startswith("ws/")
                or full_path.startswith("web/")
                or full_path == "favicon.ico"
                or full_path == "robots.txt"
                or ".well-known/" in full_path
            ):
                from fastapi import HTTPException
                raise HTTPException(status_code=404, detail="Not Found")
            return HTMLResponse((web_dist / "index.html").read_text())
    else:
        @app.get("/", response_class=JSONResponse)
        def root_nobuild() -> JSONResponse:
            return JSONResponse(
                {
                    "ok": True,
                    "name": "warlock",
                    "version": __version__,
                    "web": "not built",
                    "hint": "run `cd web && npm ci && npm run build`",
                }
            )

    return app


app = create_app()
