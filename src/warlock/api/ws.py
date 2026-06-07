"""WebSocket bus endpoint — fans `events.bus` to any connected client."""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from warlock import events
from warlock.auth import check_basic_auth
from warlock.config import get_settings

log = logging.getLogger("warlock.ws")
router = APIRouter(tags=["ws"])

# WebSocket close code for an authentication failure (RFC 6455 policy violation).
_WS_POLICY_VIOLATION = 1008


@router.websocket("/ws")
async def ws_events(ws: WebSocket) -> None:
    # /ws auth is OPT-IN (WARLOCK_WS_AUTH, default OFF). The browser WebSocket API
    # cannot set an Authorization header, so enforcing by default would 403 the web
    # event bus into a reconnect loop. When enabled (and a password is set), the
    # handshake requires the SAME HTTP Basic credential as every HTTP endpoint —
    # rejected (close before accept → HTTP 403 on the upgrade) when missing/wrong.
    # The TUI client already sends the header; the web client needs a header-free
    # path before this is flipped on.
    settings = get_settings()
    if settings.web_ws_auth and settings.web_password:
        if not check_basic_auth(ws.headers.get("authorization")):
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
