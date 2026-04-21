"""Shared gpsd TCP JSON client + broadcast bus.

Maintains a single TCP connection to gpsd, parses TPV/SKY frames, and
broadcasts them to any asyncio subscribers (WS endpoints, recorders, TUI).

Designed for graceful "no fix" handling — the reader stays connected even
when gpsd has no satellites, and snapshots return ``mode=0/1`` with a
``waiting`` reason instead of erroring.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from warlock.config import get_settings

log = logging.getLogger("warlock.gpsd")


class GpsdClient:
    """Singleton TCP client that streams gpsd JSON frames."""

    def __init__(self) -> None:
        self._settings = get_settings()
        self._task: asyncio.Task | None = None
        self._subscribers: list[asyncio.Queue[dict[str, Any]]] = []
        self._lock = asyncio.Lock()
        self.last_tpv: dict[str, Any] | None = None
        self.last_sky: dict[str, Any] | None = None
        self.connected: bool = False
        self.last_error: str | None = None

    async def start(self) -> None:
        async with self._lock:
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._runner(), name="gpsd-reader")

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.connected = False

    def subscribe(self) -> AsyncIterator[dict[str, Any]]:
        return _Subscription(self).__aiter__()

    def _add_subscriber(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.append(q)

    def _remove_subscriber(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def _runner(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self._read_loop()
                backoff = 1.0  # clean close — reset backoff
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self.last_error = f"{type(e).__name__}: {e}"
                self.connected = False
                log.warning("gpsd reader loop error: %s", self.last_error)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise
            backoff = min(backoff * 2, 30.0)

    async def _read_loop(self) -> None:
        s = self._settings
        reader, writer = await asyncio.open_connection(s.gpsd_host, s.gpsd_port)
        self.connected = True
        self.last_error = None
        try:
            writer.write(b'?WATCH={"enable":true,"json":true};\n')
            await writer.drain()
            while True:
                line = await reader.readline()
                if not line:
                    raise ConnectionError("gpsd closed connection")
                try:
                    obj = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                cls = obj.get("class")
                if cls == "TPV":
                    self.last_tpv = obj
                elif cls == "SKY":
                    self.last_sky = obj
                else:
                    continue
                payload = {"class": cls, "data": obj}
                for q in list(self._subscribers):
                    try:
                        q.put_nowait(payload)
                    except asyncio.QueueFull:
                        # Drop oldest to make room.
                        try:
                            q.get_nowait()
                            q.put_nowait(payload)
                        except Exception:  # noqa: BLE001
                            pass
        finally:
            self.connected = False
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    async def wait_for_tpv(self, timeout: float = 1.5) -> None:
        """Block briefly until we have at least one TPV cached."""
        if self.last_tpv is not None:
            return
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            if self.last_tpv is not None:
                return
            await asyncio.sleep(0.1)


class _Subscription:
    def __init__(self, client: GpsdClient) -> None:
        self._client = client
        self._q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)

    def __aiter__(self) -> "_Subscription":
        self._client._add_subscriber(self._q)
        return self

    async def __anext__(self) -> dict[str, Any]:
        try:
            return await self._q.get()
        except asyncio.CancelledError:
            self._client._remove_subscriber(self._q)
            raise

    async def aclose(self) -> None:
        self._client._remove_subscriber(self._q)


_instance: GpsdClient | None = None


def get_client() -> GpsdClient:
    global _instance
    if _instance is None:
        _instance = GpsdClient()
    return _instance
