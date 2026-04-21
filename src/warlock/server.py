"""FastAPI application — wires modules, event bus, static web build."""
from __future__ import annotations

import base64
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import HTTPConnection

from warlock import __version__
from warlock.api import engagements as engagements_api
from warlock.api import health as health_api
from warlock.api import ws as ws_api
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
    WebSocket scopes bypass Basic auth entirely — the WS endpoints are all
    LAN-trusted for now (same as ``/ws``).
    """
    if not _settings.web_password:
        return
    if conn.url.path in _UNAUTHED_PATHS or conn.url.path.startswith("/ws/"):
        return
    if conn.scope.get("type") == "websocket":
        return
    auth_header = conn.headers.get("authorization", "")
    if not auth_header.lower().startswith("basic "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="auth required",
            headers={"WWW-Authenticate": "Basic"},
        )
    try:
        decoded = base64.b64decode(auth_header.split(" ", 1)[1]).decode(
            "utf-8", errors="replace"
        )
        username, _, password = decoded.partition(":")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"malformed basic header: {e}",
            headers={"WWW-Authenticate": "Basic"},
        ) from None
    ok_user = secrets.compare_digest(username, _settings.web_username)
    ok_pass = secrets.compare_digest(password, _settings.web_password)
    if not (ok_user and ok_pass):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="bad credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("warlock v%s starting on %s:%s", __version__, _settings.host, _settings.port)
    # Dispatch module startup hooks if defined.
    for m in app.state.modules:
        if hasattr(m, "on_startup"):
            try:
                await m.on_startup()
            except Exception:  # noqa: BLE001
                log.exception("module %s startup failed", m.id)
    yield
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
    app.include_router(ws_api.router)  # auth handled per-socket

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

    # Static web build.
    web_dist: Path = _settings.web_dist
    if web_dist.exists() and (web_dist / "index.html").exists():
        app.mount("/web", StaticFiles(directory=str(web_dist), html=True), name="web")

        @app.get("/", response_class=HTMLResponse)
        def root() -> HTMLResponse:
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
