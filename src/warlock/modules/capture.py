"""Packet Capture & Expert Analysis — the "shark" (Track A / A7).

Field-tech capture + first-look analysis, Wireshark-compatible:

  GET  /api/capture/status        — tshark availability + capture count
  POST /api/capture/start         — bounded capture (iface, BPF filter, seconds, max packets) -> .pcap
  GET  /api/capture/list          — recent captures
  POST /api/capture/analyze       — expert findings + top talkers + protocol hierarchy on a capture
  GET  /api/capture/download/{id} — the raw .pcap (open in Wireshark)

Captures are local/own-segment (blue-team utility) but **always audited** (chain of custody) — a
capture sees other devices' traffic on the segment. Bounded (duration + packet caps). Uses
`tshark`; degrades to ``available:false`` if absent.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from warlock.config import get_settings
from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import AuditEntry
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.capture")
_SEARCH = ("/usr/sbin", "/sbin", "/usr/bin", "/bin")


def _tool(name: str) -> str | None:
    p = shutil.which(name)
    if p:
        return p
    for d in _SEARCH:
        c = os.path.join(d, name)
        if os.path.exists(c):
            return c
    return None


async def _run(argv: list[str], timeout: float, sudo: bool = False) -> tuple[int, str, str]:
    if not argv or argv[0] is None:
        return -1, "", "binary not found"
    full = (["sudo", "-n", *argv] if sudo else list(argv))
    try:
        proc = await asyncio.create_subprocess_exec(
            *full, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except FileNotFoundError:
        return -1, "", f"{argv[0]} not found"
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -2, "", f"{argv[0]} timed out"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def _audit(kind: str, command: str, target: str, note: str, outcome: str) -> None:
    try:
        with session_scope() as s:
            s.add(AuditEntry(engagement_id=engagement.engagement_id, kind=kind, command=command,
                             sha256=hashlib.sha256(command.encode()).hexdigest(), target=target,
                             note=note, outcome=outcome))
    except Exception:  # noqa: BLE001
        log.warning("capture audit write failed (non-fatal)", exc_info=True)
    try:
        from warlock import aar
        aar.safe_emit_for_audit(kind=kind, command=command, target=target, note=note, outcome=outcome)
    except Exception:  # noqa: BLE001
        log.debug("capture AAR emit skipped", exc_info=True)


def _cap_dir() -> Path:
    d = get_settings().data / "captures"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_id(cap_id: str) -> str:
    if not re.fullmatch(r"cap-[0-9]+-[0-9a-f]{6}", cap_id or ""):
        raise HTTPException(400, "bad capture id")
    return cap_id


async def _default_iface() -> str:
    rc, out, _ = await _run([_tool("ip"), "route", "show", "default"], timeout=6)
    m = re.search(r"dev (\S+)", out)
    return m.group(1) if m else "eth0"


class CaptureReq(BaseModel):
    iface: str | None = None
    filter: str | None = Field(default=None, description="BPF capture filter, e.g. 'udp port 5060'")
    seconds: int = Field(default=10, ge=1, le=120)
    max_packets: int = Field(default=20000, ge=1, le=500000)


class AnalyzeReq(BaseModel):
    id: str


class Module(ModuleBase):
    id = "capture"
    label = "Capture"
    icon = "◫"
    requires_engagement = False  # own-segment capture (audited); a tech's core utility

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status_ep() -> dict[str, Any]:
            return {"ok": True, "tshark": bool(_tool("tshark")), "dumpcap": bool(_tool("dumpcap")),
                    "captures": len(list(_cap_dir().glob("*.pcap")))}

        @r.post("/start")
        async def start_ep(req: CaptureReq) -> dict[str, Any]:
            if not _tool("tshark"):
                raise HTTPException(503, "tshark not installed")
            iface = req.iface or await _default_iface()
            cap_id = f"cap-{int(time.time())}-{os.urandom(3).hex()}"
            path = _cap_dir() / f"{cap_id}.pcap"
            argv = [_tool("tshark"), "-i", iface, "-a", f"duration:{req.seconds}",
                    "-c", str(req.max_packets), "-w", str(path)]
            if req.filter:
                argv += ["-f", req.filter]
            cmd = " ".join(argv[1:])
            # Capture as the service user via dumpcap's cap_net_raw capability (no sudo —
            # running tshark as root drops privs and can't write to the user's data dir).
            rc, _out, err = await _run(argv, timeout=req.seconds + 20, sudo=False)
            if rc != 0 or not path.exists():
                _audit("capture.start", cmd, iface, err.strip()[:160], "error")
                raise HTTPException(500, f"capture failed: {err.strip()[:200] or 'no output'}")
            size = path.stat().st_size
            # count packets
            rc2, out2, _ = await _run([_tool("tshark"), "-r", str(path), "-q", "-z", "io,stat,0"], timeout=30)
            pm = re.search(r"\|\s*(\d+)\s*\|\s*\d+\s*\|", out2)
            packets = int(pm.group(1)) if pm else None
            _audit("capture.start", cmd, iface, f"{packets} pkts, {size} bytes", "success")
            return {"ok": True, "id": cap_id, "iface": iface, "filter": req.filter,
                    "seconds": req.seconds, "packets": packets, "bytes": size}

        @r.get("/list")
        def list_ep() -> dict[str, Any]:
            caps = []
            for p in sorted(_cap_dir().glob("*.pcap"), key=lambda x: x.stat().st_mtime, reverse=True)[:100]:
                st = p.stat()
                caps.append({"id": p.stem, "bytes": st.st_size, "mtime": int(st.st_mtime)})
            return {"ok": True, "count": len(caps), "captures": caps}

        @r.post("/analyze")
        async def analyze_ep(req: AnalyzeReq) -> dict[str, Any]:
            path = _cap_dir() / f"{_safe_id(req.id)}.pcap"
            if not path.exists():
                raise HTTPException(404, "capture not found")
            f = str(path)
            # expert findings: group _ws.expert.message
            rc, out, _ = await _run([_tool("tshark"), "-r", f, "-T", "fields",
                                     "-e", "_ws.expert.message", "-Y", "_ws.expert"], timeout=60)
            expert: dict[str, int] = defaultdict(int)
            for line in out.splitlines():
                msg = line.strip()
                if msg:
                    expert[msg] += 1
            top_expert = sorted(({"finding": k, "count": v} for k, v in expert.items()),
                                key=lambda x: x["count"], reverse=True)[:12]
            # top talkers: aggregate ip.src/ip.dst/frame.len in python
            rc, out, _ = await _run([_tool("tshark"), "-r", f, "-T", "fields",
                                     "-e", "ip.src", "-e", "ip.dst", "-e", "frame.len"], timeout=60)
            pairs: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"frames": 0, "bytes": 0})
            for line in out.splitlines():
                cols = line.split("\t")
                if len(cols) < 3 or not cols[0] or not cols[1]:
                    continue
                key = tuple(sorted((cols[0], cols[1])))
                try:
                    pairs[key]["bytes"] += int(cols[2] or 0)
                except ValueError:
                    pass
                pairs[key]["frames"] += 1
            talkers = sorted(({"a": k[0], "b": k[1], **v} for k, v in pairs.items()),
                             key=lambda x: x["bytes"], reverse=True)[:12]
            # protocol hierarchy (raw, for the tech)
            rc, phs, _ = await _run([_tool("tshark"), "-r", f, "-q", "-z", "io,phs"], timeout=60)
            _audit("capture.analyze", f"analyze {req.id}", req.id,
                   f"{len(top_expert)} expert findings, {len(talkers)} talkers", "success")
            return {"ok": True, "id": req.id, "expert": top_expert, "top_talkers": talkers,
                    "protocol_hierarchy": phs.strip()[:4000]}

        @r.get("/download/{cap_id}")
        def download_ep(cap_id: str) -> FileResponse:
            path = _cap_dir() / f"{_safe_id(cap_id)}.pcap"
            if not path.exists():
                raise HTTPException(404, "capture not found")
            return FileResponse(str(path), media_type="application/vnd.tcpdump.pcap",
                                filename=f"{cap_id}.pcap")

        return r
