"""VoIP Troubleshooting — RTP quality / SIP / QoS (Track A / A8).

Analyzes a capture (from the A7 `capture` module) for voice quality:

  GET  /api/voip/status   — tshark availability
  POST /api/voip/analyze  — RTP streams (jitter / loss / MOS via E-model), SIP stats, DSCP/QoS check

Reads a capture by id from the captures dir. For streams negotiated by SIP/SDP tshark auto-detects
RTP; for a raw stream pass ``rtp_port`` to force the RTP dissector. MOS/R-factor is a simplified
ITU-T G.107 E-model estimate from loss + jitter (no path-latency in a one-way capture — disclosed).
The DSCP check answers "is voice actually marked EF (46) end-to-end?" — the #1 cause of choppy calls.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.voip")
_SEARCH = ("/usr/sbin", "/sbin", "/usr/bin", "/bin")

_DSCP_NAME = {46: "EF (voice)", 34: "AF41", 26: "AF31", 24: "CS3 (call-signaling)", 0: "BE (best-effort/unmarked)"}


def _tool(name: str) -> str | None:
    p = shutil.which(name)
    if p:
        return p
    for d in _SEARCH:
        c = os.path.join(d, name)
        if os.path.exists(c):
            return c
    return None


async def _run(argv: list[str], timeout: float = 60.0) -> tuple[int, str, str]:
    if not argv or argv[0] is None:
        return -1, "", "binary not found"
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except FileNotFoundError:
        return -1, "", "not found"
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -2, "", "timed out"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def _cap_path(cap_id: str) -> Path:
    if not re.fullmatch(r"cap-[0-9]+-[0-9a-f]{6}", cap_id or ""):
        raise HTTPException(400, "bad capture id")
    return get_settings().data / "captures" / f"{cap_id}.pcap"


def _mos(loss_pct: float, mean_jitter_ms: float, path_latency_ms: float = 0.0) -> tuple[float, float]:
    """Simplified E-model: returns (MOS, R-factor). No path latency in a one-way capture."""
    eff = path_latency_ms + mean_jitter_ms * 2 + 10.0
    r = 93.2 - (eff / 40.0 if eff < 160 else (eff - 120) / 10.0)
    r -= loss_pct * 2.5
    r = max(0.0, min(100.0, r))
    mos = 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r)
    return round(max(1.0, min(4.5, mos)), 2), round(r, 1)


def _quality(mos: float) -> str:
    if mos >= 4.3:
        return "excellent"
    if mos >= 4.0:
        return "good"
    if mos >= 3.6:
        return "fair"
    if mos >= 3.1:
        return "poor"
    return "bad"


_RTP_ROW = re.compile(
    r"(\d+\.\d+)\s+(\d+\.\d+)\s+"               # start end
    r"(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+"          # src ip port
    r"(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+"          # dst ip port
    r"(0x[0-9a-fA-F]+)\s+(\S+)\s+"              # ssrc payload
    r"(\d+)\s+(\d+)\s+\(([\d.]+)%\)\s+"         # pkts lost (pct)
    r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+"        # min/mean/max delta
    r"([\d.]+)\s+([\d.]+)\s+([\d.]+)"           # min/mean/max jitter
)


def _parse_rtp(text: str) -> list[dict[str, Any]]:
    streams = []
    for m in _RTP_ROW.finditer(text):
        loss_pct = float(m.group(11))
        mean_jit = float(m.group(16))
        max_jit = float(m.group(17))
        mos, r = _mos(loss_pct, mean_jit)
        streams.append({
            "src": f"{m.group(3)}:{m.group(4)}", "dst": f"{m.group(5)}:{m.group(6)}",
            "ssrc": m.group(7), "codec": m.group(8), "packets": int(m.group(9)),
            "lost": int(m.group(10)), "loss_pct": loss_pct,
            "mean_jitter_ms": mean_jit, "max_jitter_ms": max_jit,
            "mos": mos, "r_factor": r, "quality": _quality(mos),
        })
    return streams


class AnalyzeReq(BaseModel):
    id: str
    rtp_port: int | None = Field(default=None, description="force RTP dissector on this UDP port (raw streams)")


class Module(ModuleBase):
    id = "voip"
    label = "VoIP"
    icon = "☏"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status_ep() -> dict[str, Any]:
            return {"ok": True, "tshark": bool(_tool("tshark")), "checks": ["analyze"]}

        @r.post("/analyze")
        async def analyze_ep(req: AnalyzeReq) -> dict[str, Any]:
            path = _cap_path(req.id)
            if not path.exists():
                raise HTTPException(404, "capture not found")
            if not _tool("tshark"):
                raise HTTPException(503, "tshark not installed")
            f = str(path)
            decode = ["-d", f"udp.port=={req.rtp_port},rtp"] if req.rtp_port else []

            # RTP streams (jitter / loss / MOS)
            _, out, _ = await _run([_tool("tshark"), "-r", f, *decode, "-q", "-z", "rtp,streams"])
            streams = _parse_rtp(out)

            # SIP stats
            _, sip_out, _ = await _run([_tool("tshark"), "-r", f, "-q", "-z", "sip,stat"])
            sip_methods = len(re.findall(r"\b(INVITE|BYE|REGISTER|OPTIONS|ACK|CANCEL)\b", sip_out))

            # DSCP marking on RTP packets (is voice EF-marked?)
            _, dscp_out, _ = await _run([_tool("tshark"), "-r", f, *decode, "-Y", "rtp",
                                         "-T", "fields", "-e", "ip.dsfield.dscp"])
            dscp_counts = Counter(int(x) for x in dscp_out.split() if x.isdigit())
            top_dscp = dscp_counts.most_common(1)[0][0] if dscp_counts else None
            qos = {
                "rtp_dscp": top_dscp, "rtp_dscp_name": _DSCP_NAME.get(top_dscp, f"DSCP {top_dscp}") if top_dscp is not None else None,
                "marked_ef": top_dscp == 46,
                "verdict": "PASS" if top_dscp == 46 else ("WARN" if top_dscp else "INFO"),
                "note": ("voice marked EF(46)" if top_dscp == 46 else
                         (f"voice NOT marked EF — DSCP {top_dscp} ({_DSCP_NAME.get(top_dscp,'?')}); QoS will not prioritize"
                          if top_dscp is not None else "no RTP DSCP samples")),
            }

            worst = min((s["mos"] for s in streams), default=None)
            overall = (_quality(worst) if worst is not None else "no-rtp")
            return {"ok": True, "id": req.id, "rtp_streams": streams, "stream_count": len(streams),
                    "worst_mos": worst, "overall": overall, "qos": qos,
                    "sip_messages": sip_methods, "sip_raw": sip_out.strip()[:1500] or None}

        return r
