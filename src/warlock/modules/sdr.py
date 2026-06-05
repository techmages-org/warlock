"""SDR — RTL-SDR scanner MVP.

Features in this wave:
  * rtl_test-driven device probe (tuner type, count, blacklist state).
  * ADS-B via readsb (systemd-managed). ``/adsb/aircraft`` tails
    ``http://127.0.0.1:8504/data/aircraft.json``; ``/adsb/start|stop``
    flips the unit.
  * rtl_433 runs as an on-demand background subprocess, writing one
    JSON-lines event per line into ``/tmp/warlock-rtl433.jsonl``.
    ``/rtl433/events`` tails the last 100 lines.
  * Static scanner ``/presets`` list — future wave will actually tune.
  * SDR-lock lockfile ``/run/warlock/sdr.lock`` enforces single-owner.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import subprocess
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.sdr")

LOCK_PATH = Path("/run/warlock/sdr.lock")
RTL433_PID = Path("/run/warlock/rtl433.pid")
RTL433_JSONL = Path("/tmp/warlock-rtl433.jsonl")

RTL_TEST = shutil.which("rtl_test") or "/usr/bin/rtl_test"
RTL_433 = shutil.which("rtl_433") or "/usr/bin/rtl_433"
SYSTEMCTL = shutil.which("systemctl") or "/bin/systemctl"

_DEVICE_CACHE: dict[str, Any] = {"ts": 0.0, "data": None}


def _rtl_test_probe() -> dict[str, Any]:
    """Cached rtl_test -t output. 30-s TTL."""
    now = time.time()
    if _DEVICE_CACHE["data"] is not None and now - _DEVICE_CACHE["ts"] < 30:
        return _DEVICE_CACHE["data"]  # type: ignore[return-value]
    out: dict[str, Any] = {
        "detected": False,
        "tuner": None,
        "device_count": 0,
        "raw": "",
        "usb_present": False,
    }
    # 0bda:2838 = Realtek RTL2838 DVB-T (the common RTL-SDR).
    try:
        lsusb_res = subprocess.run(
            ["lsusb"], capture_output=True, text=True, timeout=2
        )
        out["usb_present"] = "0bda:2838" in (lsusb_res.stdout or "") or "0bda:2832" in (
            lsusb_res.stdout or ""
        )
    except Exception as e:  # noqa: BLE001
        log.warning("lsusb failed: %s", e)

    try:
        res = subprocess.run(
            [RTL_TEST, "-t"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        blob = (res.stdout or "") + (res.stderr or "")
        out["raw"] = blob.strip()[-1200:]
        for line in blob.splitlines():
            if line.startswith("Found "):
                # "Found 1 device(s):"
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        out["device_count"] = int(parts[1])
                    except ValueError:
                        pass
            if "Tuner:" in line:
                out["tuner"] = line.split("Tuner:", 1)[1].strip()
                out["detected"] = True
            # rtl_test also prints "Found <name> tuner"
            if line.startswith("Found ") and line.rstrip().endswith("tuner"):
                out["tuner"] = line[len("Found "):-len(" tuner")].strip()
                out["detected"] = True
            if "No supported devices found" in line:
                out["detected"] = False
        # If device_count > 0, treat as detected even without an explicit tuner line.
        if out["device_count"] > 0:
            out["detected"] = True
    except FileNotFoundError:
        out["raw"] = f"{RTL_TEST} not installed"
    except subprocess.TimeoutExpired:
        out["raw"] = "rtl_test timed out (device likely in use by another process)"
        # Device probably claimed — trust usb_present as proxy for presence.
        out["detected"] = out["usb_present"]
    except Exception as e:  # noqa: BLE001
        out["raw"] = f"rtl_test error: {e}"

    _DEVICE_CACHE.update({"ts": now, "data": out})
    return out


def _blacklist_state() -> dict[str, Any]:
    path = Path("/etc/modprobe.d/rtl-sdr-blacklist.conf")
    return {"present": path.exists(), "path": path.as_posix()}


def _systemctl_is_active(unit: str) -> bool:
    try:
        res = subprocess.run(
            [SYSTEMCTL, "is-active", unit],
            capture_output=True,
            text=True,
            timeout=3,
        )
        return (res.stdout or "").strip() == "active"
    except Exception as e:  # noqa: BLE001
        log.warning("is-active %s failed: %s", unit, e)
        return False


async def _systemctl(action: str, unit: str) -> dict[str, Any]:
    try:
        res = await asyncio.create_subprocess_exec(
            "sudo", "-n", SYSTEMCTL, action, unit,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        outb, errb = await asyncio.wait_for(res.communicate(), timeout=8)
    except asyncio.TimeoutError:
        raise HTTPException(500, f"systemctl {action} {unit} timed out") from None
    return {
        "ok": res.returncode == 0,
        "rc": res.returncode,
        "stdout": (outb or b"").decode("utf-8", errors="replace").strip(),
        "stderr": (errb or b"").decode("utf-8", errors="replace").strip(),
    }


def _lock_holder() -> str | None:
    if not LOCK_PATH.exists():
        return None
    try:
        return LOCK_PATH.read_text().strip() or None
    except Exception:  # noqa: BLE001
        return None


def _acquire_lock(holder: str) -> None:
    existing = _lock_holder()
    if existing and existing != holder:
        raise HTTPException(409, f"SDR locked by {existing!r}")
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(holder)


def _release_lock(holder: str | None = None) -> None:
    existing = _lock_holder()
    if holder and existing != holder:
        return
    try:
        LOCK_PATH.unlink()
    except FileNotFoundError:
        pass


def _rtl433_is_running() -> bool:
    if not RTL433_PID.exists():
        return False
    try:
        pid = int(RTL433_PID.read_text().strip() or "0")
    except ValueError:
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _rtl433_start() -> dict[str, Any]:
    if _rtl433_is_running():
        raise HTTPException(409, "rtl_433 already running")
    _acquire_lock("rtl_433")
    RTL433_JSONL.parent.mkdir(parents=True, exist_ok=True)
    # Truncate the jsonl each start so "last 100" is meaningful for this run.
    RTL433_JSONL.write_text("")
    try:
        proc = subprocess.Popen(
            [RTL_433, "-F", "json"],
            stdout=RTL433_JSONL.open("a", encoding="utf-8"),
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except FileNotFoundError as e:
        _release_lock("rtl_433")
        raise HTTPException(500, f"rtl_433 not found: {e}") from e
    RTL433_PID.parent.mkdir(parents=True, exist_ok=True)
    RTL433_PID.write_text(str(proc.pid))
    return {"ok": True, "pid": proc.pid, "jsonl": RTL433_JSONL.as_posix()}


def _rtl433_stop() -> dict[str, Any]:
    killed = False
    if RTL433_PID.exists():
        try:
            pid = int(RTL433_PID.read_text().strip() or "0")
        except ValueError:
            pid = 0
        if pid > 0:
            try:
                os.kill(pid, signal.SIGTERM)
                killed = True
                for _ in range(10):
                    time.sleep(0.15)
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                else:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            except ProcessLookupError:
                pass
        try:
            RTL433_PID.unlink()
        except FileNotFoundError:
            pass
    _release_lock("rtl_433")
    return {"ok": True, "killed": killed}


def _rtl433_tail(n: int = 100) -> list[dict[str, Any]]:
    if not RTL433_JSONL.exists():
        return []
    events: list[dict[str, Any]] = []
    try:
        with RTL433_JSONL.open("r", encoding="utf-8", errors="replace") as f:
            # Cheap tail: read the whole file (it'll be small — events rate is low).
            lines = f.readlines()
    except Exception:  # noqa: BLE001
        return []
    for line in lines[-n:]:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


async def _fetch_readsb_aircraft() -> dict[str, Any]:
    url = "http://127.0.0.1:8504/data/aircraft.json"
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            return r.json()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"readsb fetch failed: {e}") from e


PRESETS = [
    {"id": "fm_bcast", "label": "FM Broadcast", "freq_mhz": 98.5, "mode": "WFM", "bw_khz": 200},
    {"id": "aviation_am", "label": "Aviation AM", "freq_mhz": 118.1, "mode": "AM", "bw_khz": 25},
    {"id": "marine_vhf", "label": "Marine VHF ch16", "freq_mhz": 156.8, "mode": "FM", "bw_khz": 25},
    {"id": "ham_2m", "label": "Ham 2m", "freq_mhz": 146.52, "mode": "FM", "bw_khz": 15},
    {"id": "ham_70cm", "label": "Ham 70cm", "freq_mhz": 446.0, "mode": "FM", "bw_khz": 15},
    {"id": "ism_433", "label": "ISM 433 MHz", "freq_mhz": 433.92, "mode": "AM", "bw_khz": 400},
    {"id": "pocsag", "label": "POCSAG pager", "freq_mhz": 152.0, "mode": "FSK", "bw_khz": 20},
    {"id": "weather", "label": "NOAA Weather", "freq_mhz": 162.55, "mode": "FM", "bw_khz": 25},
]


class Module(ModuleBase):
    id = "sdr"
    label = "SDR"
    icon = "∿"
    requires_engagement = False

    async def on_shutdown(self) -> None:
        if _rtl433_is_running():
            _rtl433_stop()

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/sdr", tags=[self.id])

        @r.get("/status")
        def status() -> dict[str, Any]:
            probe = _rtl_test_probe()
            readsb_active = _systemctl_is_active("readsb")
            rtl433_active = _rtl433_is_running()
            return {
                "ok": True,
                "rtl_sdr_detected": bool(probe.get("detected") or probe.get("usb_present")),
                "tuner": probe.get("tuner"),
                "device_count": probe.get("device_count", 0),
                "usb_present": probe.get("usb_present"),
                "blacklist": _blacklist_state(),
                "readsb": {"active": readsb_active},
                "rtl_433": {"active": rtl433_active, "jsonl": RTL433_JSONL.as_posix()},
                "lock": {"holder": _lock_holder()},
                "probe_raw": probe.get("raw"),
            }

        @r.get("/adsb/aircraft")
        async def adsb_aircraft() -> dict[str, Any]:
            if not _systemctl_is_active("readsb"):
                return {"ok": False, "reason": "readsb inactive", "aircraft": []}
            try:
                data = await _fetch_readsb_aircraft()
            except HTTPException as e:
                return {"ok": False, "reason": e.detail, "aircraft": []}
            craft = data.get("aircraft") or []
            now_ts = data.get("now")
            # Normalize the subset we care about.
            rows = []
            for a in craft:
                rows.append(
                    {
                        "icao": a.get("hex"),
                        "callsign": (a.get("flight") or "").strip() or None,
                        "altitude_ft": a.get("alt_baro") or a.get("altitude"),
                        "speed_kt": a.get("gs") or a.get("speed"),
                        "heading": a.get("track"),
                        "lat": a.get("lat"),
                        "lon": a.get("lon"),
                        "rssi": a.get("rssi"),
                        "seen_s": a.get("seen"),
                        "squawk": a.get("squawk"),
                    }
                )
            return {"ok": True, "now": now_ts, "count": len(rows), "aircraft": rows}

        @r.post("/adsb/start")
        async def adsb_start() -> dict[str, Any]:
            # readsb claims the SDR; if rtl_433 or a local lock holds it, bail.
            holder = _lock_holder()
            if holder and holder != "readsb":
                raise HTTPException(409, f"SDR locked by {holder!r}")
            result = await _systemctl("start", "readsb")
            if result["ok"]:
                _acquire_lock("readsb")
            return result

        @r.post("/adsb/stop")
        async def adsb_stop() -> dict[str, Any]:
            result = await _systemctl("stop", "readsb")
            _release_lock("readsb")
            return result

        @r.get("/rtl433/events")
        def rtl433_events(n: int = 100) -> dict[str, Any]:
            n = max(1, min(1000, int(n)))
            return {"ok": True, "events": _rtl433_tail(n), "running": _rtl433_is_running()}

        @r.post("/rtl433/start")
        def rtl433_start() -> dict[str, Any]:
            holder = _lock_holder()
            if holder and holder != "rtl_433":
                raise HTTPException(409, f"SDR locked by {holder!r}")
            return _rtl433_start()

        @r.post("/rtl433/stop")
        def rtl433_stop() -> dict[str, Any]:
            return _rtl433_stop()

        @r.get("/presets")
        def presets() -> dict[str, Any]:
            return {"ok": True, "presets": PRESETS}

        @r.post("/lock/release")
        def lock_release() -> dict[str, Any]:
            _release_lock()
            return {"ok": True, "holder": _lock_holder()}

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.sdr import SdrScreen

        return SdrScreen()
