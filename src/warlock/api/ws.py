"""WebSocket bus endpoint — fans `events.bus` to any connected client."""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from warlock import events

log = logging.getLogger("warlock.ws")
router = APIRouter(tags=["ws"])


@router.websocket("/ws")
async def ws_events(ws: WebSocket) -> None:
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
