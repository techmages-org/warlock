"""WebSocket bus endpoint — fans `events.bus` to any connected client."""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from warlock import events
from warlock.auth import WS_TOKEN_TTL, check_basic_auth, make_ws_token, verify_ws_token
from warlock.config import get_settings

log = logging.getLogger("warlock.ws")
router = APIRouter(tags=["ws"])

# Token-mint endpoint lives on its own router so the server can mount it WITH the
# HTTP Basic-auth dependency, while the /ws upgrade router stays auth-free (the
# handshake authenticates itself per-socket below).
token_router = APIRouter(tags=["ws"])

# WebSocket close code for an authentication failure (RFC 6455 policy violation).
_WS_POLICY_VIOLATION = 1008


@token_router.get("/api/ws-token")
def ws_token() -> dict:
    """Mint a short-lived signed token for a browser /ws handshake.

    Behind HTTP Basic auth (mounted with the ``_check_auth`` dependency). The
    browser fetches this, then connects to ``/ws?token=<token>`` — its only way
    to authenticate the bus, since the WebSocket API can't set an Authorization
    header. TTL is short (``WS_TOKEN_TTL`` seconds); the client refetches.
    """
    return {"token": make_ws_token(), "expires_in": WS_TOKEN_TTL}


@router.websocket("/ws")
async def ws_events(ws: WebSocket) -> None:
    # /ws auth is enforced by default (WARLOCK_WS_AUTH, default ON) whenever a
    # web password is set. The browser WebSocket API cannot send an Authorization
    # header, so the handshake is accepted with EITHER a valid HTTP Basic header
    # (the TUI client) OR a valid ?token=… query param minted by GET /api/ws-token
    # (the browser). Neither/invalid → close before accept (1008 policy violation
    # → HTTP 403 on the upgrade). When no password is set, auth is fully disabled
    # (open LAN deck) exactly as before.
    settings = get_settings()
    if settings.web_ws_auth and settings.web_password:
        authorized = check_basic_auth(ws.headers.get("authorization"))
        if not authorized:
            authorized = verify_ws_token(ws.query_params.get("token"))
        if not authorized:
            log.warning("ws: rejected unauthenticated handshake from %s", ws.client)
            await ws.close(code=_WS_POLICY_VIOLATION)
            return
    await ws.accept()
    try:
        await ws.send_text(json.dumps({"name": "ws.hello", "payload": {"ok": True}}))
        async for evt in events.bus.subscribe():
            try:
                await ws.send_text(json.dumps(evt.to_dict()))
            except Exception:
                break
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        log.exception("ws handler crashed")
