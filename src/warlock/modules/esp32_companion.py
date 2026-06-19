"""ESP32 Companion — serial device detection + Marauder command bridge.

Detects USB-serial ESP32 devices, connects to the Marauder firmware's
text-based serial CLI, and exposes a clean REST surface for the TUI/web
to drive WiFi/BLE offensive operations through the companion hardware.

Gate behaviour:
  - Detection (/detect, /status) does NOT require engagement.
  - Scanning (/scan, /scan_sta, /list) does NOT require engagement
    (recon is passive — the Marauder is listening, not transmitting).
  - Attack commands (/attack, /stop) DO require engagement + scope match
    (the Marauder transmits — deauth frames, beacon spam, BLE spam).
"""
from __future__ import annotations

import asyncio
import glob
import logging
import os
from typing import Any

import serial
import serial.tools.list_ports
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from warlock.config import get_settings
from warlock.engagement import engagement
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.esp32_companion")

# Baud rate for ESP32 Marauder serial CLI.
MARAUDER_BAUD = 115200

# USB-serial chip IDs commonly used by ESP32 boards.
_KNOWN_CHIPS = {
    (0x1A86, 0x7523): "CH340",
    (0x1A86, 0x55D4): "CH9102",
    (0x10C4, 0xEA60): "CP2102",
    (0x0403, 0x6001): "FT232",
    (0x303A, 0x1001): "ESP32-S2 native USB",
    (0x303A, 0x1002): "ESP32-S3 native USB",
}


def _detect_serial_devices() -> list[dict[str, Any]]:
    """Scan /dev/ttyUSB*, /dev/ttyACM* and pyserial's list_ports for ESP32 candidates."""
    devices: list[dict[str, Any]] = []
    seen: set[str] = set()

    for port in serial.tools.list_ports.comports():
        path = port.device
        if path in seen or not os.path.exists(path):
            continue
        seen.add(path)

        chip = _KNOWN_CHIPS.get((port.vid, port.pid), None) if port.vid else None
        # Heuristic: ESP32 Marauder boards typically use CH340/CH9102/CP2102
        # or native USB (ESP32-S2/S3). Not all serial devices are ESP32s,
        # but we list candidates and let the operator confirm.
        is_candidate = chip is not None or "ESP32" in (port.product or "").upper()

        devices.append({
            "device": path,
            "description": port.description or port.product or "",
            "vid": f"0x{port.vid:04X}" if port.vid else None,
            "pid": f"0x{port.pid:04X}" if port.pid else None,
            "serial_number": port.serial_number,
            "chip": chip,
            "esp32_candidate": is_candidate,
        })

    # Also glob raw device paths that pyserial might miss.
    for pattern in ("/dev/ttyUSB*", "/dev/ttyACM*"):
        for path in glob.glob(pattern):
            if path in seen:
                continue
            seen.add(path)
            try:
                st = os.stat(path)
                accessible = os.access(path, os.R_OK | os.W_OK)
            except OSError:
                accessible = False
            devices.append({
                "device": path,
                "description": "raw serial device",
                "vid": None,
                "pid": None,
                "serial_number": None,
                "chip": None,
                "esp32_candidate": False,
                "accessible": accessible,
            })

    return sorted(devices, key=lambda d: d["device"])


class MarauderCompanion:
    """Async wrapper around the ESP32 Marauder serial CLI."""

    def __init__(self) -> None:
        self._serial: serial.Serial | None = None
        self._device: str | None = None
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._serial is not None and self._serial.is_open

    @property
    def device(self) -> str | None:
        return self._device

    async def connect(self, device: str, baud: int = MARAUDER_BAUD) -> dict[str, Any]:
        async with self._lock:
            if self.connected:
                await self._disconnect_locked()
            try:
                self._serial = serial.Serial(device, baud, timeout=1)
                self._device = device
                # Read the Marauder banner / prompt.
                banner = self._read_output(timeout_s=2.0)
                log.info("connected to ESP32 at %s", device)
                return {
                    "ok": True,
                    "device": device,
                    "baud": baud,
                    "banner": banner[:500] if banner else "",
                }
            except Exception as e:
                self._serial = None
                self._device = None
                raise RuntimeError(f"failed to open {device}: {e}") from e

    async def disconnect(self) -> dict[str, Any]:
        async with self._lock:
            dev = self._device
            await self._disconnect_locked()
            return {"ok": True, "device": dev}

    async def _disconnect_locked(self) -> None:
        if self._serial:
            try:
                self._serial.close()
            except Exception:  # noqa: BLE001
                pass
        self._serial = None
        self._device = None

    def _read_output(self, timeout_s: float = 1.0) -> str:
        """Read all available serial output, waiting up to timeout_s."""
        import time
        if not self._serial or not self._serial.is_open:
            return ""
        buf = bytearray()
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            waiting = self._serial.in_waiting
            if waiting:
                chunk = self._serial.read(waiting)
                buf.extend(chunk)
                deadline = time.monotonic() + 0.3  # extend on data
            else:
                time.sleep(0.05)
        return buf.decode(errors="replace").strip()

    async def send_command(self, cmd: str, read_timeout: float = 3.0) -> dict[str, Any]:
        """Send a text command to the Marauder CLI and capture output."""
        async with self._lock:
            if not self.connected:
                raise RuntimeError("not connected — call /connect first")
            self._serial.write(f"{cmd}\n".encode())
            self._serial.flush()
            output = self._read_output(timeout_s=read_timeout)
            return {"ok": True, "command": cmd, "output": output[:2000]}


companion = MarauderCompanion()


# --- Pydantic models ---

class ConnectBody(BaseModel):
    device: str
    baud: int = MARAUDER_BAUD


class CommandBody(BaseModel):
    command: str
    read_timeout: float = 3.0


class AttackBody(BaseModel):
    attack_type: str  # "deauth", "beacon", "probe", "rickroll"
    target: str | None = None  # BSSID or SSID
    read_timeout: float = 5.0


# --- Module ---

class Module(ModuleBase):
    id = "esp32_companion"
    label = "ESP32 Companion"
    icon = "⌁"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def companion_status() -> dict[str, Any]:
            return {
                "module": self.id,
                "label": self.label,
                "connected": companion.connected,
                "device": companion.device,
                "status": "connected" if companion.connected else "disconnected",
            }

        @r.get("/detect")
        def detect() -> dict[str, Any]:
            """Scan for ESP32 serial devices. No engagement required."""
            devices = _detect_serial_devices()
            candidates = [d for d in devices if d.get("esp32_candidate")]
            return {
                "ok": True,
                "devices": devices,
                "count": len(devices),
                "esp32_candidates": len(candidates),
            }

        @r.post("/connect")
        async def connect_dev(body: ConnectBody) -> dict[str, Any]:
            """Open a serial connection to a detected ESP32 device."""
            try:
                return await companion.connect(body.device, body.baud)
            except RuntimeError as e:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

        @r.post("/disconnect")
        async def disconnect_dev() -> dict[str, Any]:
            return await companion.disconnect()

        @r.post("/command")
        async def send_cmd(body: CommandBody) -> dict[str, Any]:
            """Send a raw Marauder CLI command (passthrough)."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            try:
                return await companion.send_command(body.command, body.read_timeout)
            except RuntimeError as e:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

        @r.get("/scan")
        async def scan_ap() -> dict[str, Any]:
            """Passive WiFi AP scan via Marauder. No engagement required."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            result = await companion.send_command("scanap", read_timeout=15.0)
            # Parse AP list from Marauder output
            return result

        @r.get("/scan_sta")
        async def scan_sta() -> dict[str, Any]:
            """Passive WiFi station scan via Marauder."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            return await companion.send_command("scansta", read_timeout=15.0)

        @r.get("/list")
        async def list_targets() -> dict[str, Any]:
            """List detected APs and stations from last scan."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            return await companion.send_command("list -a", read_timeout=2.0)

        @r.post("/attack")
        async def attack(body: AttackBody) -> dict[str, Any]:
            """Launch an attack via the Marauder. REQUIRES engagement + scope."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            if not engagement.is_on():
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "attack commands require an active engagement",
                )
            # Map attack_type to Marauder commands.
            cmd_map = {
                "deauth": "attack deauth",
                "beacon": "attack beacon spam",
                "probe": "attack probe",
                "rickroll": "attack rickroll",
            }
            cmd = cmd_map.get(body.attack_type)
            if not cmd:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"unknown attack type: {body.attack_type}",
                )
            # If a target BSSID is specified, select it first.
            if body.target:
                await companion.send_command(f"select -a {body.target}", read_timeout=1.0)
            from warlock.aar import builder
            builder.safe_emit_for_audit(
                kind="esp32.attack",
                command=cmd,
                target=body.target or "broadcast",
                note=f"Marauder {body.attack_type} via {companion.device}",
                outcome="launched",
            )
            return await companion.send_command(cmd, read_timeout=body.read_timeout)

        @r.post("/stop")
        async def stop_attack() -> dict[str, Any]:
            """Stop the current Marauder attack/scan."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            return await companion.send_command("stop", read_timeout=2.0)

        @r.get("/help")
        async def help_cmds() -> dict[str, Any]:
            """Fetch available Marauder commands (passthrough 'help')."""
            if not companion.connected:
                raise HTTPException(status.HTTP_409_CONFLICT, "not connected")
            return await companion.send_command("help", read_timeout=2.0)

        return r
