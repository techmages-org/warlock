"""Audio module — wpctl/PipeWire frontend for sink/source selection + volume."""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.audio")


def _user_env() -> dict[str, str]:
    """Find sem's PipeWire session env (DBUS, XDG_RUNTIME_DIR, WAYLAND_DISPLAY)."""
    env = os.environ.copy()
    try:
        out = subprocess.run(
            ["pgrep", "-u", "sem", "-f", "pipewire "],
            capture_output=True, text=True, timeout=2,
        )
        for pid in (out.stdout or "").strip().splitlines():
            try:
                with open(f"/proc/{pid.strip()}/environ", "rb") as fh:
                    raw = fh.read().decode("utf-8", "ignore")
                for line in raw.split("\0"):
                    if line.startswith(("DBUS_SESSION_BUS_ADDRESS=", "XDG_RUNTIME_DIR=", "WAYLAND_DISPLAY=")):
                        k, v = line.split("=", 1)
                        env[k] = v
                if "DBUS_SESSION_BUS_ADDRESS" in env:
                    break
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    return env


async def _wpctl(*args: str) -> str:
    """Run wpctl as sem's user with the right session env. Returns stdout."""
    env = _user_env()
    proc = await asyncio.create_subprocess_exec(
        "wpctl", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=4.0)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "wpctl timed out")
    if proc.returncode != 0:
        raise HTTPException(500, f"wpctl {' '.join(args)} failed: {stderr.decode().strip()}")
    return stdout.decode()


def _parse_status(text: str) -> dict[str, Any]:
    """Parse wpctl status into structured sink/source lists."""
    section: str | None = None
    sinks: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for raw_line in text.splitlines():
        s = raw_line.strip(" │└├─*")
        line = raw_line.lstrip(" │└├─")
        if line.startswith("Sinks:"):
            section = "sinks"; continue
        if line.startswith("Sources:"):
            section = "sources"; continue
        if line.startswith(("Filters:", "Streams:", "Devices:", "Clients:", "Video", "Audio")):
            section = None; continue
        if section is None or not s or not s[0].isdigit():
            continue
        # Format: "* 55. Yealink BT51 Analog Stereo            [vol: 1.00]"
        is_default = "*" in raw_line.split(".")[0]
        try:
            ix_dot = s.index(".")
            node_id = int(s[:ix_dot].strip())
            rest = s[ix_dot + 1 :].strip()
            vol = None
            if "[vol:" in rest:
                head, tail = rest.split("[vol:", 1)
                rest = head.strip()
                vol_str = tail.split("]", 1)[0].strip()
                # vol may be "1.00" or "1.00 [MUTED]"
                muted = "MUTED" in vol_str
                vol_str = vol_str.replace("[MUTED]", "").strip()
                try:
                    vol = float(vol_str)
                except ValueError:
                    vol = None
            else:
                muted = False
            entry = {
                "id": node_id,
                "name": rest,
                "default": is_default,
                "volume": vol,
                "muted": muted,
            }
            if section == "sinks":
                sinks.append(entry)
            else:
                sources.append(entry)
        except (ValueError, IndexError):
            continue
    return {"sinks": sinks, "sources": sources}


class SetDefaultBody(BaseModel):
    id: int


class SetVolumeBody(BaseModel):
    id: int
    volume: float  # 0.0 - 1.5


class SetMuteBody(BaseModel):
    id: int
    muted: bool


class PlayTestBody(BaseModel):
    id: int | None = None  # if None, plays on current default


class Module(ModuleBase):
    id = "audio"
    label = "Audio"
    icon = "🔊"
    requires_engagement = False
    requires_root = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/audio", tags=["audio"])

        @r.get("/devices")
        async def devices() -> dict[str, Any]:
            text = await _wpctl("status")
            return {"ok": True, **_parse_status(text)}

        @r.post("/default")
        async def set_default(body: SetDefaultBody) -> dict[str, Any]:
            await _wpctl("set-default", str(body.id))
            return {"ok": True, "id": body.id}

        @r.post("/volume")
        async def set_volume(body: SetVolumeBody) -> dict[str, Any]:
            v = max(0.0, min(1.5, body.volume))
            await _wpctl("set-volume", str(body.id), f"{v:.3f}")
            return {"ok": True, "id": body.id, "volume": v}

        @r.post("/mute")
        async def set_mute(body: SetMuteBody) -> dict[str, Any]:
            await _wpctl("set-mute", str(body.id), "1" if body.muted else "0")
            return {"ok": True, "id": body.id, "muted": body.muted}

        @r.post("/test")
        async def play_test(body: PlayTestBody) -> dict[str, Any]:
            """Play Front_Center.wav on the chosen sink (or current default)."""
            wav = "/usr/share/sounds/alsa/Front_Center.wav"
            env = _user_env()
            if body.id is not None:
                # Play to a specific sink via pw-cat --target
                await asyncio.create_subprocess_exec(
                    "pw-cat", "-p", "--target", str(body.id), wav,
                    env=env,
                )
            else:
                await asyncio.create_subprocess_exec("pw-play", wav, env=env)
            return {"ok": True, "played": wav, "target": body.id}

        @r.get("/status")
        async def status() -> dict[str, Any]:
            text = await _wpctl("status")
            data = _parse_status(text)
            sink = next((s for s in data["sinks"] if s["default"]), None)
            src = next((s for s in data["sources"] if s["default"]), None)
            return {
                "ok": True,
                "default_sink": sink,
                "default_source": src,
                "sink_count": len(data["sinks"]),
                "source_count": len(data["sources"]),
            }

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.stub import StubScreen
        return StubScreen(module_id=self.id, label=self.label)
