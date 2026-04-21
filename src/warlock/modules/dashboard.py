"""Dashboard — real-time system telemetry tiles."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import socket
import subprocess
from datetime import datetime
from pathlib import Path

import psutil
from fastapi import APIRouter

from warlock.config import get_settings
from warlock.engagement import engagement
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.dashboard")


def _read_cpu_temp_c() -> float | None:
    candidates = [
        Path("/sys/class/thermal/thermal_zone0/temp"),
        Path("/sys/class/hwmon/hwmon0/temp1_input"),
    ]
    for p in candidates:
        try:
            raw = int(p.read_text().strip())
            return round(raw / 1000.0, 1)
        except Exception:  # noqa: BLE001
            continue
    return None


def _vcgencmd_throttled() -> str | None:
    if not shutil.which("vcgencmd"):
        return None
    try:
        out = subprocess.run(
            ["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2
        )
        return out.stdout.strip() or None
    except Exception:  # noqa: BLE001
        return None


def _rtc_drift_seconds() -> float | None:
    """diff = (hwclock --utc -r) - (system time). Needs sudo; returns None if unavailable."""
    if not shutil.which("hwclock"):
        return None
    try:
        # Try without sudo first (may work if CAP is set).
        out = subprocess.run(
            ["hwclock", "-r", "--utc"], capture_output=True, text=True, timeout=2
        )
        if out.returncode != 0:
            return None
        # "2026-04-21 15:01:14.123456+00:00" — dateutil-free parse.
        line = out.stdout.strip()
        # Strip trailing timezone for fromisoformat-friendly string.
        m = re.match(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)", line)
        if not m:
            return None
        hw = datetime.fromisoformat(m.group(1))
        sys_now = datetime.utcnow()
        return round((hw - sys_now).total_seconds(), 3)
    except Exception:  # noqa: BLE001
        return None


def _chrony_tracking() -> dict:
    if not shutil.which("chronyc"):
        return {"ok": False, "reason": "chronyc not installed"}
    try:
        out = subprocess.run(
            ["chronyc", "-n", "tracking"], capture_output=True, text=True, timeout=2
        )
        if out.returncode != 0:
            return {"ok": False, "reason": out.stderr.strip()}
        stratum: int | None = None
        offset: float | None = None
        source: str | None = None
        for line in out.stdout.splitlines():
            if line.startswith("Stratum"):
                try:
                    stratum = int(line.split(":", 1)[1].strip())
                except Exception:  # noqa: BLE001
                    pass
            elif line.startswith("Last offset"):
                m = re.search(r"([-+]?\d+\.\d+)", line)
                if m:
                    offset = float(m.group(1))
            elif line.startswith("Reference ID"):
                parts = line.split(":", 1)
                if len(parts) == 2:
                    source = parts[1].strip()
        return {"ok": True, "stratum": stratum, "offset_s": offset, "source": source}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}


async def _gpsd_fix() -> dict:
    """Talk to gpsd directly over TCP (avoid gpsd-py3 dep). Short timeout."""
    s = get_settings()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(s.gpsd_host, s.gpsd_port), timeout=1.0
        )
    except Exception:  # noqa: BLE001
        return {"ok": False, "reason": "gpsd unreachable"}
    try:
        writer.write(b'?WATCH={"enable":true,"json":true};\n')
        await writer.drain()
        deadline = asyncio.get_event_loop().time() + 2.0
        result: dict = {"ok": False, "reason": "no TPV received"}
        while asyncio.get_event_loop().time() < deadline:
            remaining = deadline - asyncio.get_event_loop().time()
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=max(0.1, remaining))
            except asyncio.TimeoutError:
                break
            if not line:
                break
            try:
                obj = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if obj.get("class") == "TPV":
                result = {
                    "ok": True,
                    "mode": obj.get("mode", 0),  # 0=no, 1=no fix, 2=2D, 3=3D
                    "lat": obj.get("lat"),
                    "lon": obj.get("lon"),
                    "alt": obj.get("altMSL") or obj.get("alt"),
                    "speed": obj.get("speed"),
                    "track": obj.get("track"),
                    "time": obj.get("time"),
                }
                break
            if obj.get("class") == "SKY":
                result.setdefault("satellites_used", obj.get("uSat"))
                result.setdefault("satellites_seen", obj.get("nSat"))
        return result
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


def _nmcli_active() -> list[dict]:
    if not shutil.which("nmcli"):
        return []
    try:
        out = subprocess.run(
            ["nmcli", "-t", "-f", "NAME,DEVICE,STATE,TYPE", "con", "show", "--active"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        rows: list[dict] = []
        for line in out.stdout.splitlines():
            parts = line.split(":")
            if len(parts) >= 4:
                rows.append(
                    {"name": parts[0], "device": parts[1], "state": parts[2], "type": parts[3]}
                )
        return rows
    except Exception:  # noqa: BLE001
        return []


async def _mesh_node_count() -> int | None:
    s = get_settings()
    try:
        # Quick TCP probe; expensive import of meshtastic lib is deferred to mesh module.
        fut = asyncio.open_connection(s.mesh_host, s.mesh_port)
        _, writer = await asyncio.wait_for(fut, timeout=1.0)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        return None
    # Delegate real node enumeration to mesh module.
    try:
        from warlock.modules.mesh import node_count

        return await node_count()
    except Exception:  # noqa: BLE001
        return None


def _sdr_devices() -> dict:
    if not shutil.which("rtl_test"):
        return {"ok": False, "reason": "rtl_test not installed"}
    try:
        out = subprocess.run(
            ["rtl_test", "-t"], capture_output=True, text=True, timeout=2
        )
        text = (out.stdout + out.stderr) or ""
        # rtl_test prints "Found N device(s)" to stderr.
        m = re.search(r"Found\s+(\d+)\s+device", text)
        return {"ok": True, "count": int(m.group(1)) if m else 0}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}


class Module(ModuleBase):
    id = "dashboard"
    label = "Dashboard"
    icon = "●"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/dashboard", tags=[self.id])

        @r.get("/status")
        async def status() -> dict:
            load1, load5, load15 = os.getloadavg()
            du = psutil.disk_usage("/")
            mem = psutil.virtual_memory()
            payload = {
                "hostname": socket.gethostname(),
                "now": datetime.utcnow().isoformat(),
                "cpu": {
                    "load_1m": round(load1, 2),
                    "load_5m": round(load5, 2),
                    "load_15m": round(load15, 2),
                    "count": psutil.cpu_count(),
                    "percent": psutil.cpu_percent(interval=None),
                },
                "memory": {
                    "total_mb": round(mem.total / 1_048_576, 1),
                    "available_mb": round(mem.available / 1_048_576, 1),
                    "percent": mem.percent,
                },
                "temp_c": _read_cpu_temp_c(),
                "throttled": _vcgencmd_throttled(),
                "disk_root_mb_free": round(du.free / 1_048_576, 1),
                "disk_root_percent": du.percent,
                "rtc_drift_s": _rtc_drift_seconds(),
                "chrony": _chrony_tracking(),
                "gps": await _gpsd_fix(),
                "nmcli_active": _nmcli_active(),
                "mesh_node_count": await _mesh_node_count(),
                "sdr": _sdr_devices(),
                "engagement": engagement.status(),
            }
            return payload

        return r
