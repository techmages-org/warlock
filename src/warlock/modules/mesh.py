"""Mesh — Meshtastic command center (native TCP API on 4403)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from warlock import events
from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.mesh")


class _MeshClient:
    """Thin cached-connection wrapper around meshtastic.tcp_interface.TCPInterface.

    Created lazily and lived for the life of the daemon. `meshtastic` fires
    pubsub messages into `pubsub` — we forward a small subset to `events.bus`.
    """

    def __init__(self) -> None:
        self._iface: Any | None = None
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def interface(self) -> Any:
        async with self._lock:
            if self._iface is None:
                self._loop = asyncio.get_running_loop()
                self._iface = await asyncio.to_thread(self._connect)
            return self._iface

    def _connect(self) -> Any:
        # Imports deferred — meshtastic is heavy.
        from meshtastic.tcp_interface import TCPInterface
        from pubsub import pub  # provided by pypubsub, pulled in by meshtastic

        s = get_settings()
        iface = TCPInterface(hostname=s.mesh_host, portNumber=s.mesh_port)
        # Bridge pubsub → async event bus.
        pub.subscribe(self._on_receive, "meshtastic.receive")
        return iface

    def _on_receive(self, packet, interface) -> None:  # noqa: D401 — pubsub signature
        """pypubsub callback — runs in meshtastic's reader thread."""
        try:
            # Minimize payload for transport; drop binary fields.
            decoded = packet.get("decoded") if isinstance(packet, dict) else None
            payload = {
                "from": packet.get("fromId") or packet.get("from"),
                "to": packet.get("toId") or packet.get("to"),
                "channel": packet.get("channel"),
                "portnum": decoded.get("portnum") if decoded else None,
                "text": decoded.get("text") if decoded else None,
                "rxSnr": packet.get("rxSnr"),
                "rxRssi": packet.get("rxRssi"),
                "ts": datetime.utcnow().isoformat(),
            }
            loop = self._loop
            if loop is not None and loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    events.bus.publish(events.MESH_PACKET_RX, payload), loop
                )
        except Exception:  # noqa: BLE001
            log.exception("mesh packet bridge failed")

    async def nodes(self) -> list[dict]:
        iface = await self.interface()

        def _collect() -> list[dict]:
            out: list[dict] = []
            db = getattr(iface, "nodes", None) or {}
            for nid, n in db.items():
                user = (n or {}).get("user") or {}
                pos = (n or {}).get("position") or {}
                out.append(
                    {
                        "id": nid,
                        "num": (n or {}).get("num"),
                        "long_name": user.get("longName"),
                        "short_name": user.get("shortName"),
                        "hw": user.get("hwModel"),
                        "last_heard": (n or {}).get("lastHeard"),
                        "snr": (n or {}).get("snr"),
                        "hops_away": (n or {}).get("hopsAway"),
                        "battery_pct": ((n or {}).get("deviceMetrics") or {}).get(
                            "batteryLevel"
                        ),
                        "lat": pos.get("latitude"),
                        "lon": pos.get("longitude"),
                        "alt": pos.get("altitude"),
                    }
                )
            return out

        return await asyncio.to_thread(_collect)

    async def channels(self) -> list[dict]:
        iface = await self.interface()

        def _collect() -> list[dict]:
            try:
                chans = iface.localNode.channels or []
            except Exception:  # noqa: BLE001
                return []
            rows: list[dict] = []
            for c in chans:
                settings = getattr(c, "settings", None)
                rows.append(
                    {
                        "index": getattr(c, "index", None),
                        "role": getattr(c, "role", None),
                        "name": getattr(settings, "name", None) if settings else None,
                        "psk_set": bool(getattr(settings, "psk", None)) if settings else False,
                    }
                )
            return rows

        return await asyncio.to_thread(_collect)

    async def send_text(self, text: str, channel: int = 0, destination: str | None = None) -> dict:
        iface = await self.interface()

        def _send() -> dict:
            kwargs: dict = {"channelIndex": channel}
            if destination:
                kwargs["destinationId"] = destination
            iface.sendText(text, **kwargs)
            return {"ok": True}

        return await asyncio.to_thread(_send)


_client = _MeshClient()


async def node_count() -> int | None:
    try:
        nodes = await _client.nodes()
        return len(nodes)
    except Exception:  # noqa: BLE001
        return None


class SendIn(BaseModel):
    text: str
    channel: int = 0
    destination: str | None = None


class Module(ModuleBase):
    id = "mesh"
    label = "Mesh"
    icon = "⌬"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/mesh", tags=[self.id])

        @r.get("/status")
        async def status() -> dict:
            try:
                n = await _client.nodes()
                return {"ok": True, "nodes": len(n)}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": str(e)}

        @r.get("/nodes")
        async def nodes() -> list[dict]:
            try:
                return await _client.nodes()
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"meshtasticd: {e}") from e

        @r.get("/channels")
        async def channels() -> list[dict]:
            try:
                return await _client.channels()
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"meshtasticd: {e}") from e

        @r.post("/send")
        async def send(body: SendIn) -> dict:
            try:
                return await _client.send_text(body.text, body.channel, body.destination)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"send failed: {e}") from e

        @r.websocket("/packets")
        async def packets_ws(ws: WebSocket) -> None:
            await ws.accept()
            try:
                async for evt in events.bus.subscribe():
                    if evt.name != events.MESH_PACKET_RX:
                        continue
                    await ws.send_json(evt.to_dict())
            except WebSocketDisconnect:
                return

        return r

    def tui_screen(self):
        from warlock.tui.screens.mesh import MeshScreen

        return MeshScreen()
