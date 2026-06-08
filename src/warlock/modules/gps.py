"""GPS — live fix, sky view, chrony/PPS, GPX tracks, WebSocket stream.

Uses a single shared ``GpsdClient`` singleton for gpsd I/O. Graceful
"waiting for fix" when mode<2 — no HTTP errors, no 5xx toasts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from warlock.gpsd_client import get_client
from warlock.modules._base import ModuleBase
from warlock.tracks import get_recorder, list_tracks, safe_track_path, tracks_dir

log = logging.getLogger("warlock.gps")


_GNSS_NAMES = {
    0: "GPS",
    1: "SBAS",
    2: "Galileo",
    3: "BeiDou",
    4: "IMES",
    5: "QZSS",
    6: "GLONASS",
    7: "NavIC",
}


def _constellation(sat: dict[str, Any]) -> str:
    gid = sat.get("gnssid")
    if isinstance(gid, int) and gid in _GNSS_NAMES:
        return _GNSS_NAMES[gid]
    # Fallback by PRN range when gnssid missing.
    prn = sat.get("PRN") or sat.get("svid")
    if isinstance(prn, int):
        if 1 <= prn <= 32:
            return "GPS"
        if 65 <= prn <= 96:
            return "GLONASS"
        if 120 <= prn <= 158:
            return "SBAS"
        if 193 <= prn <= 197:
            return "QZSS"
        if 201 <= prn <= 237:
            return "BeiDou"
        if 211 <= prn <= 246:
            return "Galileo"
    return "?"


def _fix_snapshot() -> dict[str, Any]:
    c = get_client()
    tpv = c.last_tpv
    sky = c.last_sky
    if tpv is None and not c.connected:
        return {
            "ok": False,
            "reason": c.last_error or "gpsd unreachable",
            "connected": False,
        }
    mode = int(tpv.get("mode", 0)) if tpv else 0
    out: dict[str, Any] = {
        "ok": True,
        "connected": c.connected,
        "mode": mode,
        "waiting": None if mode >= 2 else "no fix (awaiting sky view)",
    }
    if tpv:
        out.update(
            {
                "lat": tpv.get("lat"),
                "lon": tpv.get("lon"),
                "alt": tpv.get("altMSL") or tpv.get("alt"),
                "speed_mps": tpv.get("speed"),
                "track_deg": tpv.get("track"),
                "climb_mps": tpv.get("climb"),
                "time": tpv.get("time"),
                "epx": tpv.get("epx"),
                "epy": tpv.get("epy"),
                "epv": tpv.get("epv"),
            }
        )
    if sky:
        sats = sky.get("satellites") or []
        used = sum(1 for s in sats if s.get("used"))
        out.update(
            {
                "hdop": sky.get("hdop"),
                "vdop": sky.get("vdop"),
                "pdop": sky.get("pdop"),
                "gdop": sky.get("gdop"),
                "satellites_seen": sky.get("nSat") or len(sats),
                "satellites_used": sky.get("uSat") or used,
            }
        )
    return out


def current_position() -> dict[str, Any] | None:
    """Best-effort current GPS fix for geo-stamping callers (e.g. wifi_recon
    wardriving). Returns ``{lat, lon, alt, time, mode}`` only when there is a real
    2D+ fix; ``None`` otherwise (no fix / gpsd down) so the caller records nulls."""
    snap = _fix_snapshot()
    if not snap.get("ok") or (snap.get("mode") or 0) < 2:
        return None
    lat, lon = snap.get("lat"), snap.get("lon")
    if lat is None or lon is None:
        return None
    return {"lat": lat, "lon": lon, "alt": snap.get("alt"), "time": snap.get("time"), "mode": snap.get("mode")}


def _sats_snapshot() -> dict[str, Any]:
    c = get_client()
    sky = c.last_sky
    if sky is None and not c.connected:
        return {"ok": False, "reason": c.last_error or "gpsd unreachable", "satellites": []}
    sats_raw = (sky.get("satellites") if sky else None) or []
    sats: list[dict[str, Any]] = []
    for s in sats_raw:
        sats.append(
            {
                "prn": s.get("PRN") or s.get("svid"),
                "gnssid": s.get("gnssid"),
                "constellation": _constellation(s),
                "elevation": s.get("el"),
                "azimuth": s.get("az"),
                "snr": s.get("ss"),
                "used": bool(s.get("used")),
                "health": s.get("health"),
            }
        )
    sats.sort(key=lambda x: (-(x.get("snr") or 0), x.get("prn") or 0))
    return {
        "ok": True,
        "connected": c.connected,
        "satellites": sats,
        "seen": len(sats),
        "used": sum(1 for s in sats if s["used"]),
    }


def _chrony_tracking() -> dict[str, Any]:
    if not shutil.which("chronyc"):
        return {"ok": False, "reason": "chronyc not installed"}
    try:
        out = subprocess.run(
            ["chronyc", "-n", "tracking"], capture_output=True, text=True, timeout=2
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}
    if out.returncode != 0:
        return {"ok": False, "reason": (out.stderr or out.stdout).strip()}
    d: dict[str, Any] = {"ok": True}
    for line in out.stdout.splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if key == "Reference ID":
            d["reference_id"] = val
        elif key == "Stratum":
            try:
                d["stratum"] = int(val)
            except ValueError:
                pass
        elif key == "Last offset":
            m = re.search(r"([-+]?\d+\.\d+)", val)
            if m:
                d["last_offset_s"] = float(m.group(1))
        elif key == "RMS offset":
            m = re.search(r"([-+]?\d+\.\d+)", val)
            if m:
                d["rms_offset_s"] = float(m.group(1))
        elif key == "Frequency":
            m = re.search(r"([-+]?\d+\.\d+)", val)
            if m:
                d["frequency_ppm"] = float(m.group(1))
        elif key == "Skew":
            m = re.search(r"([-+]?\d+\.\d+)", val)
            if m:
                d["skew_ppm"] = float(m.group(1))
        elif key == "Root delay":
            m = re.search(r"([-+]?\d+\.\d+)", val)
            if m:
                d["root_delay_s"] = float(m.group(1))
        elif key == "Root dispersion":
            m = re.search(r"([-+]?\d+\.\d+)", val)
            if m:
                d["root_dispersion_s"] = float(m.group(1))
    return d


def _chrony_refclocks() -> list[dict[str, Any]]:
    if not shutil.which("chronyc"):
        return []
    try:
        out = subprocess.run(
            ["chronyc", "-n", "sources", "-v"], capture_output=True, text=True, timeout=2
        )
    except Exception:  # noqa: BLE001
        return []
    rows: list[dict[str, Any]] = []
    for line in out.stdout.splitlines():
        # Data rows start with mode/state char columns; match GPS/PPS specifically.
        m = re.match(
            r"^[#\^=]\S?\s+(GPS|PPS)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([-+]?\d+\S*)",
            line,
        )
        if not m:
            continue
        rows.append(
            {
                "source": m.group(1),
                "stratum": int(m.group(2)),
                "poll_log2": int(m.group(3)),
                "reach_octal": m.group(4),
                "last_rx": m.group(5),
                "last_sample": m.group(6),
            }
        )
    return rows


def _pps_probe() -> dict[str, Any]:
    """Best-effort: is /dev/pps0 present and (if quick) is it pulsing?"""
    info: dict[str, Any] = {"device": "/dev/pps0", "present": False, "pulsing": None}
    try:
        from pathlib import Path as _P

        if _P("/dev/pps0").exists():
            info["present"] = True
    except Exception:  # noqa: BLE001
        pass
    if not info["present"] or not shutil.which("ppstest"):
        return info
    try:
        out = subprocess.run(
            ["ppstest", "/dev/pps0"], capture_output=True, text=True, timeout=1.2
        )
        info["pulsing"] = "assert" in (out.stdout or "")
    except subprocess.TimeoutExpired:
        # Timeout is expected — ppstest blocks waiting for pulses.
        info["pulsing"] = False
    except Exception as e:  # noqa: BLE001
        info["error"] = str(e)
    return info


class Module(ModuleBase):
    id = "gps"
    label = "GPS"
    icon = "🛰"
    requires_engagement = False

    async def on_startup(self) -> None:
        try:
            await get_client().start()
        except Exception:  # noqa: BLE001
            log.exception("gpsd client failed to start")

    async def on_shutdown(self) -> None:
        try:
            rec = get_recorder()
            if rec.active:
                await rec.stop()
            await get_client().stop()
        except Exception:  # noqa: BLE001
            log.exception("gps shutdown cleanup failed")

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/gps", tags=[self.id])

        @r.get("/fix")
        async def fix() -> dict[str, Any]:
            c = get_client()
            await c.start()
            await c.wait_for_tpv(timeout=1.0)
            return _fix_snapshot()

        @r.get("/sats")
        async def sats() -> dict[str, Any]:
            c = get_client()
            await c.start()
            await c.wait_for_tpv(timeout=0.5)
            return _sats_snapshot()

        @r.get("/time")
        async def time_status() -> dict[str, Any]:
            tracking = await asyncio.to_thread(_chrony_tracking)
            refclocks = await asyncio.to_thread(_chrony_refclocks)
            pps = await asyncio.to_thread(_pps_probe)
            return {
                "ok": True,
                "tracking": tracking,
                "refclocks": refclocks,
                "pps": pps,
            }

        @r.get("/tracks")
        async def tracks() -> dict[str, Any]:
            rows = await asyncio.to_thread(list_tracks)
            rec = get_recorder()
            return {"ok": True, "tracks": rows, "recording": rec.status}

        @r.post("/tracks/start")
        async def tracks_start() -> dict[str, Any]:
            return await get_recorder().start()

        @r.post("/tracks/stop")
        async def tracks_stop() -> dict[str, Any]:
            return await get_recorder().stop()

        @r.get("/tracks/{filename}")
        async def tracks_get(filename: str) -> FileResponse:
            try:
                path = safe_track_path(filename)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            if not path.exists():
                raise HTTPException(status_code=404, detail="track not found")
            return FileResponse(
                str(path),
                media_type="application/gpx+xml",
                filename=filename,
            )

        @r.delete("/tracks/{filename}")
        async def tracks_delete(filename: str) -> dict[str, Any]:
            try:
                path = safe_track_path(filename)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            rec = get_recorder()
            if rec.active and rec._path and rec._path.name == filename:
                raise HTTPException(status_code=409, detail="cannot delete active recording")
            if not path.exists():
                raise HTTPException(status_code=404, detail="track not found")
            path.unlink()
            return {"ok": True, "deleted": filename}

        @r.websocket("/stream")
        async def stream(ws: WebSocket) -> None:
            await ws.accept()
            client = get_client()
            await client.start()
            # Send initial snapshot so consumer renders immediately.
            try:
                await ws.send_text(
                    json.dumps({"class": "HELLO", "fix": _fix_snapshot(), "sats": _sats_snapshot()})
                )
            except Exception:  # noqa: BLE001
                return
            sub = client.subscribe()
            try:
                async for evt in sub:
                    try:
                        await ws.send_text(json.dumps(evt))
                    except Exception:  # noqa: BLE001
                        break
            except WebSocketDisconnect:
                pass
            finally:
                try:
                    await sub.aclose()  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    pass

        # Ensure tracks dir exists on first hit.
        tracks_dir()
        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.gps import GpsScreen

        return GpsScreen()
