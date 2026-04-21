"""GPX track recording + listing helpers.

A single ``TrackRecorder`` singleton appends <trkpt> entries to a GPX
file while a recording is active. Lightweight stream parser pulls a
summary (size / point count / start / end) from existing files without
loading them fully into memory.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from warlock.config import get_settings
from warlock.gpsd_client import get_client

log = logging.getLogger("warlock.tracks")

_TIME_RE = re.compile(r"<time>([^<]+)</time>")
_TRKPT_RE = re.compile(r"<trkpt\s")


def tracks_dir() -> Path:
    p = get_settings().data / "tracks"
    p.mkdir(parents=True, exist_ok=True)
    return p


def gpx_summary(path: Path) -> dict[str, Any]:
    """Return filename/size/point-count/first-last timestamps by streaming."""
    size = path.stat().st_size
    points = 0
    first_time: str | None = None
    last_time: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if _TRKPT_RE.search(line):
                    points += 1
                    m = _TIME_RE.search(line)
                    if m:
                        if first_time is None:
                            first_time = m.group(1)
                        last_time = m.group(1)
    except Exception as e:  # noqa: BLE001
        log.warning("failed to summarise %s: %s", path, e)
    duration: int | None = None
    if first_time and last_time and first_time != last_time:
        try:
            t0 = datetime.fromisoformat(first_time.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(last_time.replace("Z", "+00:00"))
            duration = int(round((t1 - t0).total_seconds()))
        except Exception:  # noqa: BLE001
            pass
    return {
        "filename": path.name,
        "size_bytes": size,
        "points": points,
        "started_at": first_time,
        "ended_at": last_time,
        "duration_s": duration,
    }


def list_tracks() -> list[dict[str, Any]]:
    rows = [gpx_summary(p) for p in sorted(tracks_dir().glob("*.gpx"))]
    rows.sort(key=lambda r: r.get("started_at") or r.get("filename") or "", reverse=True)
    return rows


def safe_track_path(filename: str) -> Path:
    """Resolve a user-supplied track filename under the tracks dir, safely."""
    if "/" in filename or ".." in filename or not filename.endswith(".gpx"):
        raise ValueError("invalid track filename")
    p = (tracks_dir() / filename).resolve()
    if not str(p).startswith(str(tracks_dir().resolve())):
        raise ValueError("path escapes tracks dir")
    return p


class TrackRecorder:
    """Background asyncio task writing TPV fixes to a GPX file."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._path: Path | None = None
        self._points: int = 0
        self._started_at: str | None = None
        self._lock = asyncio.Lock()

    @property
    def active(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def status(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "path": str(self._path) if self._path else None,
            "filename": self._path.name if self._path else None,
            "points": self._points,
            "started_at": self._started_at,
        }

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            if self.active:
                return {"ok": False, "reason": "already recording", **self.status}
            now = datetime.now(timezone.utc)
            fname = now.strftime("%Y%m%d-%H%M%S") + ".gpx"
            self._path = tracks_dir() / fname
            self._points = 0
            self._started_at = now.isoformat().replace("+00:00", "Z")
            self._write_skeleton(fname)
            self._task = asyncio.create_task(self._run(), name="gpx-recorder")
            log.info("track recording started: %s", self._path)
            return {"ok": True, **self.status}

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            if not self.active:
                return {"ok": False, "reason": "no active recording", **self.status}
            assert self._task is not None
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
            log.info("track recording stopped: %s (%d points)", self._path, self._points)
            result = {"ok": True, **self.status}
            return result

    def _write_skeleton(self, name: str) -> None:
        assert self._path is not None
        self._path.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<gpx version="1.1" creator="Warlock" '
            'xmlns="http://www.topografix.com/GPX/1/1">\n'
            f"<trk><name>{name}</name><trkseg>\n"
            "</trkseg></trk>\n"
            "</gpx>\n",
            encoding="utf-8",
        )

    async def _run(self) -> None:
        client = get_client()
        await client.start()
        last_ts: str | None = None
        while True:
            await asyncio.sleep(1.0)
            tpv = client.last_tpv
            if not tpv:
                continue
            if int(tpv.get("mode") or 0) < 2:
                continue
            lat = tpv.get("lat")
            lon = tpv.get("lon")
            if lat is None or lon is None:
                continue
            ts = tpv.get("time") or datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            if ts == last_ts:
                continue
            ele = tpv.get("altMSL")
            if ele is None:
                ele = tpv.get("alt")
            await asyncio.to_thread(self._append_point, float(lat), float(lon), ele, ts)
            last_ts = ts

    def _append_point(
        self, lat: float, lon: float, ele: float | None, ts: str
    ) -> None:
        if self._path is None:
            return
        ele_tag = f"<ele>{ele}</ele>" if ele is not None else ""
        pt = f'    <trkpt lat="{lat}" lon="{lon}">{ele_tag}<time>{ts}</time></trkpt>\n'
        try:
            content = self._path.read_text(encoding="utf-8", errors="replace")
            if "</trkseg>" not in content:
                return
            content = content.replace("</trkseg>", pt + "</trkseg>", 1)
            self._path.write_text(content, encoding="utf-8")
            self._points += 1
        except Exception:  # noqa: BLE001
            log.exception("failed to append trkpt to %s", self._path)


_recorder: TrackRecorder | None = None


def get_recorder() -> TrackRecorder:
    global _recorder
    if _recorder is None:
        _recorder = TrackRecorder()
    return _recorder
