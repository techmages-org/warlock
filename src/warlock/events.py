"""Async pub/sub event bus shared by TUI + web (via WebSocket)."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class Event:
    name: str
    payload: dict[str, Any] = field(default_factory=dict)
    ts: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "payload": self.payload, "ts": self.ts}


# Known event names (string constants for discoverability).
ENGAGEMENT_STARTED = "engagement.started"
ENGAGEMENT_ENDED = "engagement.ended"
KILLSWITCH_PRESSED = "killswitch.pressed"
ALERT_FIRED = "alert.fired"
MESH_PACKET_RX = "mesh.packet.rx"
GPS_FIX_UPDATED = "gps.fix.updated"
JOB_STARTED = "job.started"
JOB_FINISHED = "job.finished"


class Bus:
    """Fan-out asyncio event bus. Subscribers receive every published event."""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[Event]] = []
        self._lock = asyncio.Lock()

    async def publish(self, name: str, payload: dict[str, Any] | None = None) -> None:
        evt = Event(name=name, payload=payload or {})
        async with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                # Slow consumer: drop. TODO: per-subscriber backpressure.
                pass

    async def subscribe(self) -> AsyncIterator[Event]:
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._subscribers.append(q)
        try:
            while True:
                yield await q.get()
        finally:
            async with self._lock:
                if q in self._subscribers:
                    self._subscribers.remove(q)


bus = Bus()
