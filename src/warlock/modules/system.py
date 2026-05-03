"""System — hardware, services, network, journal control surface.

Backend exposes:
  GET  /api/system/status            — temps/throttle/mem/disk/uptime/gpu/audio
  GET  /api/system/aio               — GPIO 6/7/16/23/27 state
  POST /api/system/aio/{rail}/on     — restart aiov2-{rail}-on.service (clean)
  POST /api/system/aio/{rail}/off    — pinctrl op dl override (dirty; reverts on service restart)
  GET  /api/system/services          — list active/enabled state of important units
  POST /api/system/services/{name}/{action}
  GET  /api/system/journal           — journalctl tail with filters
  GET  /api/system/network           — interfaces with up/down/IPs/MAC/SSID
  POST /api/system/wlan/scan         — passive WLAN AP list
  POST /api/system/reboot            — schedule reboot in 10s   (requires sudoers / NoNewPrivileges=false)
  POST /api/system/shutdown          — schedule shutdown in 10s (requires sudoers / NoNewPrivileges=false)

Reboot/shutdown require either passwordless sudo or polkit rules; see the
warlock.service unit which already sets ``NoNewPrivileges=false`` plus the
``sem ALL=(ALL) NOPASSWD: ALL`` sudoers rule shipped on this image.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import socket
import subprocess
from datetime import datetime
from typing import Any

import psutil
from fastapi import APIRouter, HTTPException

from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.system")

# AIO V2 rail map (GPIO → service / label).
AIO_RAILS: dict[str, dict[str, Any]] = {
    "gps":          {"gpio": 16, "service": "aiov2-gps-on.service",          "label": "GPS"},
    "lora":         {"gpio": 23, "service": "aiov2-lora-on.service",         "label": "LoRa"},
    "internal_usb": {"gpio": 27, "service": "aiov2-internal-usb-on.service", "label": "Internal USB / SDR"},
    # Reserved/spare pins surfaced as read-only to ops:
    "spare6":       {"gpio": 6,  "service": None, "label": "Spare GPIO6"},
    "spare7":       {"gpio": 7,  "service": None, "label": "Spare GPIO7"},
}

KNOWN_SERVICES: list[str] = [
    "warlock", "meshtasticd", "gpsd", "chrony",
    "aiov2-gps-on", "aiov2-lora-on", "aiov2-internal-usb-on",
    "docker", "tor", "fail2ban", "kismet",
]

ALLOWED_SERVICE_ACTIONS = {"start", "stop", "restart", "enable", "disable"}


def _read_thermal() -> float | None:
    for p in ("/sys/class/thermal/thermal_zone0/temp", "/sys/class/hwmon/hwmon0/temp1_input"):
        try:
            with open(p) as fh:
                return round(int(fh.read().strip()) / 1000.0, 1)
        except Exception:  # noqa: BLE001
            continue
    return None


def _vc(args: list[str]) -> str:
    if not shutil.which("vcgencmd"):
        return ""
    try:
        out = subprocess.run(["vcgencmd", *args], capture_output=True, text=True, timeout=2)
        return (out.stdout or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _pinctrl_get(gpio: int) -> dict[str, Any]:
    """Parse pinctrl output: '16: op dh pd | hi // GPIO16 = output'."""
    if not shutil.which("pinctrl"):
        return {"gpio": gpio, "available": False}
    try:
        out = subprocess.run(["pinctrl", "get", str(gpio)], capture_output=True, text=True, timeout=2)
        text = (out.stdout or "").strip()
    except Exception:  # noqa: BLE001
        return {"gpio": gpio, "available": False}
    info: dict[str, Any] = {"gpio": gpio, "available": True, "raw": text}
    # "op dh pd | hi" → mode=op, level=hi (or `pn | lo` for input)
    m = re.match(r"\d+:\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?\s*\|\s*(\S+)", text)
    if m:
        info["mode"] = m.group(1)         # ip|op|no
        info["drive"] = m.group(2) or ""  # dh|dl
        info["pull"] = m.group(3) or ""   # pu|pd|pn|--
        info["level"] = m.group(4)        # hi|lo
    return info


def _is_active(unit: str) -> dict[str, Any]:
    """Return systemctl state for a single unit (without sudo)."""
    out = subprocess.run(
        ["systemctl", "show", unit, "--no-page",
         "-p", "ActiveState", "-p", "SubState", "-p", "LoadState",
         "-p", "UnitFileState", "-p", "MainPID"],
        capture_output=True, text=True, timeout=2,
    )
    info: dict[str, Any] = {"unit": unit}
    for line in out.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k.lower()] = v
    info["active"] = info.get("activestate") == "active"
    info["enabled"] = info.get("unitfilestate", "") in ("enabled", "enabled-runtime", "static")
    return info


async def _run(argv: list[str], timeout: float = 6.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "", "timeout"
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


def _audio_sink() -> str:
    """Best-effort default sink description from wpctl status."""
    if not shutil.which("wpctl"):
        return ""
    try:
        out = subprocess.run(["wpctl", "status"], capture_output=True, text=True, timeout=2)
        for line in (out.stdout or "").splitlines():
            if "*" in line and ("." in line):
                # "│  *   55. Yealink ..."
                bits = line.split(".", 1)
                if len(bits) == 2:
                    return bits[1].strip().split("[")[0].strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


class Module(ModuleBase):
    id = "system"
    label = "System"
    icon = "⚙"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/system", tags=[self.id])

        @r.get("/status")
        def status_ep() -> dict[str, Any]:
            mem = psutil.virtual_memory()
            du = psutil.disk_usage("/")
            uptime_s = int(datetime.utcnow().timestamp() - psutil.boot_time())
            return {
                "ok": True,
                "hostname": socket.gethostname(),
                "now": datetime.utcnow().isoformat(),
                "uptime_s": uptime_s,
                "cpu_percent": psutil.cpu_percent(interval=None),
                "load_avg": list(os.getloadavg()),
                "temp_c": _read_thermal(),
                "throttled": _vc(["get_throttled"]),
                "gpu_temp": _vc(["measure_temp"]),
                "core_volt": _vc(["measure_volts", "core"]),
                "memory": {
                    "total_mb": round(mem.total / 1_048_576, 1),
                    "available_mb": round(mem.available / 1_048_576, 1),
                    "percent": mem.percent,
                },
                "disk_root": {
                    "free_mb": round(du.free / 1_048_576, 1),
                    "total_mb": round(du.total / 1_048_576, 1),
                    "percent": du.percent,
                },
                "audio_sink": _audio_sink(),
            }

        @r.get("/aio")
        def aio_ep() -> dict[str, Any]:
            rails: dict[str, Any] = {}
            for rail, meta in AIO_RAILS.items():
                pin = _pinctrl_get(meta["gpio"])
                pin["service"] = meta.get("service")
                pin["label"] = meta.get("label")
                rails[rail] = pin
            return {"ok": True, "rails": rails}

        @r.post("/aio/{rail}/on")
        async def aio_on(rail: str) -> dict[str, Any]:
            meta = AIO_RAILS.get(rail)
            if meta is None:
                raise HTTPException(404, f"unknown rail {rail!r}")
            svc = meta.get("service")
            if not svc:
                # Spare pins: drive high directly via pinctrl.
                rc, _o, e = await _run(["sudo", "-n", "pinctrl", "set", str(meta["gpio"]), "op", "dh"])
                if rc != 0:
                    raise HTTPException(500, f"pinctrl failed: {e.strip()}")
                return {"ok": True, "rail": rail, "method": "pinctrl-dh"}
            rc, _o, e = await _run(["sudo", "-n", "systemctl", "restart", svc])
            if rc != 0:
                raise HTTPException(500, f"systemctl restart {svc} failed: {e.strip()}")
            return {"ok": True, "rail": rail, "method": "service-restart", "service": svc}

        @r.post("/aio/{rail}/off")
        async def aio_off(rail: str) -> dict[str, Any]:
            meta = AIO_RAILS.get(rail)
            if meta is None:
                raise HTTPException(404, f"unknown rail {rail!r}")
            # Always pull the pin low. Service restart on next boot will restore.
            rc, _o, e = await _run(["sudo", "-n", "pinctrl", "set", str(meta["gpio"]), "op", "dl"])
            if rc != 0:
                raise HTTPException(500, f"pinctrl failed: {e.strip()}")
            return {"ok": True, "rail": rail, "method": "pinctrl-dl",
                    "note": "rail will be restored on next aiov2-*-on service restart"}

        @r.get("/services")
        def services_ep() -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            for u in KNOWN_SERVICES:
                rows.append(_is_active(u))
            return {"ok": True, "services": rows}

        @r.post("/services/{name}/{action}")
        async def services_action(name: str, action: str) -> dict[str, Any]:
            if name not in KNOWN_SERVICES:
                raise HTTPException(404, f"service {name!r} not in allowlist")
            if action not in ALLOWED_SERVICE_ACTIONS:
                raise HTTPException(400, f"action must be one of {sorted(ALLOWED_SERVICE_ACTIONS)}")
            rc, _o, e = await _run(["sudo", "-n", "systemctl", action, name], timeout=15.0)
            if rc != 0:
                raise HTTPException(500, f"systemctl {action} {name} failed: {e.strip()[:200]}")
            return {"ok": True, "unit": name, "action": action, "state": _is_active(name)}

        @r.get("/journal")
        async def journal_ep(unit: str | None = None, priority: int = 7,
                             lines: int = 200, since: str | None = None) -> dict[str, Any]:
            lines = max(1, min(2000, int(lines)))
            priority = max(0, min(7, int(priority)))
            argv = ["journalctl", "-n", str(lines), "-p", str(priority), "--no-pager", "-o", "short-iso"]
            if unit:
                # Whitelist unit names to alphanumeric + dash/underscore/dot/@
                if not re.match(r"^[A-Za-z0-9_.@\-]+$", unit):
                    raise HTTPException(400, "invalid unit name")
                argv += ["-u", unit]
            if since:
                if not re.match(r"^[A-Za-z0-9 :\-]+$", since):
                    raise HTTPException(400, "invalid since")
                argv += ["--since", since]
            rc, out, _e = await _run(argv, timeout=10.0)
            if rc != 0:
                # Try with sudo (some units restrict)
                rc, out, _e = await _run(["sudo", "-n", *argv], timeout=10.0)
            text = out.strip()
            return {"ok": True, "lines": text.splitlines() if text else [], "argv": argv, "rc": rc}

        @r.get("/network")
        def network_ep() -> dict[str, Any]:
            ifaces: list[dict[str, Any]] = []
            try:
                addrs = psutil.net_if_addrs()
                stats = psutil.net_if_stats()
            except Exception:  # noqa: BLE001
                return {"ok": False, "interfaces": []}
            for name, addr_list in addrs.items():
                row: dict[str, Any] = {"name": name, "up": False, "ipv4": [], "ipv6": [], "mac": "", "type": "unknown"}
                st = stats.get(name)
                if st is not None:
                    row["up"] = st.isup
                    row["mtu"] = st.mtu
                    row["speed"] = st.speed
                for a in addr_list:
                    if a.family == socket.AF_INET:
                        row["ipv4"].append(a.address)
                    elif a.family == socket.AF_INET6:
                        row["ipv6"].append(a.address.split("%", 1)[0])
                    elif str(a.family).endswith("AF_PACKET") or a.family == 17:
                        row["mac"] = a.address
                # Type heuristic
                if name == "lo":
                    row["type"] = "loopback"
                elif name.startswith("docker") or name.startswith("br-"):
                    row["type"] = "bridge"
                elif name.startswith("veth"):
                    row["type"] = "veth"
                elif name.startswith(("wlan", "wlp", "wifi", "mon")):
                    row["type"] = "wifi"
                elif name.startswith(("eth", "enp", "enx", "end")):
                    row["type"] = "eth"
                elif name.startswith(("tun", "tap")):
                    row["type"] = "tunnel"
                # WiFi extras
                if row["type"] == "wifi" and shutil.which("iw"):
                    try:
                        out = subprocess.run(["iw", "dev", name, "link"], capture_output=True, text=True, timeout=2)
                        for line in (out.stdout or "").splitlines():
                            line = line.strip()
                            if line.startswith("SSID:"):
                                row["ssid"] = line.split(":", 1)[1].strip()
                            elif line.startswith("signal:"):
                                row["signal"] = line.split(":", 1)[1].strip()
                    except Exception:  # noqa: BLE001
                        pass
                ifaces.append(row)
            return {"ok": True, "interfaces": ifaces}

        @r.post("/wlan/scan")
        async def wlan_scan() -> dict[str, Any]:
            # Use nmcli (NetworkManager) — passive, no engagement gate.
            if not shutil.which("nmcli"):
                raise HTTPException(503, "nmcli not available")
            await _run(["nmcli", "device", "wifi", "rescan"], timeout=15.0)
            rc, out, e = await _run(
                ["nmcli", "-t", "-f", "BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY,IN-USE",
                 "device", "wifi", "list"], timeout=15.0,
            )
            if rc != 0:
                raise HTTPException(500, f"nmcli failed: {e.strip()[:200]}")
            aps: list[dict[str, Any]] = []
            for line in (out or "").splitlines():
                # nmcli -t escapes ':' inside BSSID with backslash; un-escape.
                parts: list[str] = []
                buf = ""
                i = 0
                while i < len(line):
                    c = line[i]
                    if c == "\\" and i + 1 < len(line):
                        buf += line[i + 1]; i += 2; continue
                    if c == ":":
                        parts.append(buf); buf = ""; i += 1; continue
                    buf += c; i += 1
                parts.append(buf)
                if len(parts) >= 6:
                    aps.append({
                        "bssid": parts[0], "ssid": parts[1], "channel": parts[2],
                        "freq": parts[3], "signal": parts[4], "security": parts[5],
                        "in_use": (parts[6] == "*") if len(parts) > 6 else False,
                    })
            return {"ok": True, "aps": aps, "count": len(aps)}

        @r.post("/reboot")
        async def reboot_ep() -> dict[str, Any]:
            log.warning("REBOOT scheduled in 10s via /api/system/reboot")
            asyncio.create_task(_delayed_run(["sudo", "-n", "systemctl", "reboot"], delay=10.0))
            return {"ok": True, "scheduled_in_s": 10}

        @r.post("/shutdown")
        async def shutdown_ep() -> dict[str, Any]:
            log.warning("SHUTDOWN scheduled in 10s via /api/system/shutdown")
            asyncio.create_task(_delayed_run(["sudo", "-n", "systemctl", "poweroff"], delay=10.0))
            return {"ok": True, "scheduled_in_s": 10}

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.system import SystemScreen
        return SystemScreen()


async def _delayed_run(argv: list[str], delay: float) -> None:
    await asyncio.sleep(delay)
    try:
        proc = await asyncio.create_subprocess_exec(*argv)
        await proc.wait()
    except Exception:  # noqa: BLE001
        log.exception("delayed run failed: %s", argv)
