"""Wi-Fi Analyzer — AirCheck-class wireless survey (Track A / A3).

Passive, blue-team wireless visibility for the field tech:

  POST /api/wifi_analyzer/scan      — AP map: BSSID/SSID/band/channel/RSSI/quality (sorted by signal)
  POST /api/wifi_analyzer/channels  — per-band channel congestion (AP count) + utilization (survey)
  POST /api/wifi_analyzer/roam      — current association + roam candidates (same SSID, ranked)
  GET  /api/wifi_analyzer/status    — wifi iface + current association summary

Built on `iw scan` / `iw survey dump` / `iw link` (passive — no engagement gate). Scans run on the
chosen wifi iface (default the connected one); a single scan is non-disruptive. Degrades gracefully
when `iw` is missing. Pairs with `wireless_ids` (rogue/anomaly) and feeds the A6 walk-test + A4 report.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.wifi_analyzer")

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


async def _run(argv: list[str], timeout: float = 12.0, sudo: bool = False) -> tuple[int, str, str]:
    if not argv or argv[0] is None:
        return -1, "", "binary not found"
    full = (["sudo", "-n", *argv] if sudo else list(argv))
    try:
        proc = await asyncio.create_subprocess_exec(
            *full, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except FileNotFoundError:
        return -1, "", f"{argv[0]} not found"
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -2, "", f"{argv[0]} timed out"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def _chan_from_freq(mhz: int | None) -> int | None:
    if not mhz:
        return None
    if mhz == 2484:
        return 14
    if 2412 <= mhz <= 2472:
        return (mhz - 2407) // 5
    if 5000 <= mhz <= 5900:
        return (mhz - 5000) // 5
    if 5955 <= mhz <= 7115:
        return (mhz - 5950) // 5
    return None


def _band(mhz: int | None) -> str | None:
    if not mhz:
        return None
    return "2.4" if mhz < 2500 else ("5" if mhz < 5925 else "6")


def _quality(dbm: float | None) -> str:
    if dbm is None:
        return "unknown"
    if dbm >= -60:
        return "excellent"
    if dbm >= -70:
        return "good"
    if dbm >= -80:
        return "fair"
    return "poor"


def _parse_scan(text: str) -> list[dict[str, Any]]:
    aps: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for line in text.splitlines():
        m = re.match(r"^BSS ([0-9a-fA-F:]{17})\(on \S+\)(\s*--\s*associated)?", line)
        if m:
            if cur:
                aps.append(cur)
            cur = {"bssid": m.group(1).lower(), "associated": bool(m.group(2)),
                   "ssid": None, "freq_mhz": None, "signal_dbm": None}
            continue
        if cur is None:
            continue
        s = line.strip()
        if s.startswith("freq:"):
            try:
                cur["freq_mhz"] = int(float(s.split(":", 1)[1]))
            except ValueError:
                pass
        elif s.startswith("signal:"):
            mm = re.search(r"(-?\d+(?:\.\d+)?)", s)
            if mm:
                cur["signal_dbm"] = float(mm.group(1))
        elif s.startswith("SSID:"):
            cur["ssid"] = s.split(":", 1)[1].strip() or "(hidden)"
    if cur:
        aps.append(cur)
    for a in aps:
        a["channel"] = _chan_from_freq(a["freq_mhz"])
        a["band"] = _band(a["freq_mhz"])
        a["quality"] = _quality(a["signal_dbm"])
    return aps


async def _scan(iface: str) -> list[dict[str, Any]]:
    rc, out, err = await _run([_tool("iw"), "dev", iface, "scan"], sudo=True, timeout=20)
    if rc != 0:
        raise HTTPException(503, f"iw scan failed on {iface}: {err.strip()[:140] or 'unavailable'}")
    aps = _parse_scan(out)
    aps.sort(key=lambda a: (a["signal_dbm"] if a["signal_dbm"] is not None else -999), reverse=True)
    return aps


async def _survey(iface: str) -> list[dict[str, Any]]:
    rc, out, _ = await _run([_tool("iw"), "dev", iface, "survey", "dump"], sudo=True, timeout=8)
    chans: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("frequency:"):
            if cur:
                chans.append(cur)
            mm = re.search(r"(\d+) MHz", s)
            cur = {"freq_mhz": int(mm.group(1)) if mm else None, "in_use": "in use" in s,
                   "active_ms": None, "busy_ms": None}
        elif cur and s.startswith("channel active time:"):
            mm = re.search(r"(\d+)", s)
            cur["active_ms"] = int(mm.group(1)) if mm else None
        elif cur and s.startswith("channel busy time:"):
            mm = re.search(r"(\d+)", s)
            cur["busy_ms"] = int(mm.group(1)) if mm else None
    if cur:
        chans.append(cur)
    out_chans = []
    for c in chans:
        c["channel"] = _chan_from_freq(c["freq_mhz"])
        c["band"] = _band(c["freq_mhz"])
        if c.get("active_ms") and c.get("busy_ms") is not None and c["active_ms"] > 0:
            c["utilization_pct"] = round(c["busy_ms"] / c["active_ms"] * 100, 1)
        if c.get("channel"):
            out_chans.append(c)
    return out_chans


async def _link(iface: str) -> dict[str, Any]:
    rc, out, _ = await _run([_tool("iw"), "dev", iface, "link"], sudo=True, timeout=6)
    if rc != 0 or "Not connected" in out:
        return {"connected": False, "iface": iface}

    def g(p: str) -> str | None:
        m = re.search(p, out)
        return m.group(1).strip() if m else None

    bss = re.search(r"Connected to ([0-9a-fA-F:]{17})", out)
    sig = g(r"signal:\s*(-?\d+)")
    return {"connected": True, "iface": iface,
            "bssid": bss.group(1).lower() if bss else None,
            "ssid": g(r"SSID:\s*(.+)"), "freq_mhz": g(r"freq:\s*([\d.]+)"),
            "signal_dbm": float(sig) if sig else None, "quality": _quality(float(sig) if sig else None),
            "tx_bitrate": g(r"tx bitrate:\s*(.+)")}


def _operstate(iface: str) -> str:
    try:
        return open(f"/sys/class/net/{iface}/operstate").read().strip()
    except OSError:
        return "unknown"


async def _wifi_iface(req_iface: str | None) -> str:
    if req_iface:
        return req_iface
    rc, out, _ = await _run([_tool("iw"), "dev"], timeout=6)
    ifaces = re.findall(r"Interface (\S+)", out)
    if not ifaces:
        return "wlan0"
    # prefer an UP interface (a down radio can't scan); else the first listed.
    up = [i for i in ifaces if _operstate(i) == "up"]
    return up[0] if up else ifaces[0]


def _zone(dbm: float | None) -> str:
    """Walk-test coverage classification."""
    if dbm is None:
        return "dead"
    if dbm >= -60:
        return "hot"
    if dbm >= -70:
        return "warm"
    if dbm >= -80:
        return "cold"
    return "dead"


def _walk_file():
    d = get_settings().data / "walktest"
    d.mkdir(parents=True, exist_ok=True)
    return d / "current.jsonl"


class IfaceReq(BaseModel):
    iface: str | None = None


class WalkReq(IfaceReq):
    label: str | None = None
    target_ssid: str | None = None
    target_bssid: str | None = None


class Module(ModuleBase):
    id = "wifi_analyzer"
    label = "WiFi Analyzer"
    icon = "≋"
    requires_engagement = False  # passive survey — blue-team

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        async def status_ep() -> dict[str, Any]:
            iface = await _wifi_iface(None)
            return {"ok": True, "iface": iface, "link": await _link(iface),
                    "tools": {"iw": bool(_tool("iw")), "nmcli": bool(_tool("nmcli"))},
                    "checks": ["scan", "channels", "roam"]}

        @r.post("/scan")
        async def scan_ep(req: IfaceReq) -> dict[str, Any]:
            iface = await _wifi_iface(req.iface)
            aps = await _scan(iface)
            bands: dict[str, int] = {}
            for a in aps:
                if a["band"]:
                    bands[a["band"]] = bands.get(a["band"], 0) + 1
            return {"ok": True, "iface": iface, "count": len(aps), "by_band": bands, "aps": aps}

        @r.post("/channels")
        async def channels_ep(req: IfaceReq) -> dict[str, Any]:
            iface = await _wifi_iface(req.iface)
            aps = await _scan(iface)
            survey = {c["channel"]: c for c in await _survey(iface) if c.get("channel")}
            by_band: dict[str, dict[int, dict[str, Any]]] = {}
            for a in aps:
                if not a["band"] or a["channel"] is None:
                    continue
                slot = by_band.setdefault(a["band"], {}).setdefault(
                    a["channel"], {"channel": a["channel"], "ap_count": 0, "utilization_pct": None})
                slot["ap_count"] += 1
                sv = survey.get(a["channel"])
                if sv and sv.get("utilization_pct") is not None:
                    slot["utilization_pct"] = sv["utilization_pct"]
            result = {b: sorted(chs.values(), key=lambda c: c["channel"]) for b, chs in by_band.items()}
            # least-congested recommendation per band (fewest APs)
            rec = {b: min(chs, key=lambda c: c["ap_count"])["channel"] for b, chs in result.items() if chs}
            return {"ok": True, "iface": iface, "channels": result, "least_congested": rec}

        @r.post("/roam")
        async def roam_ep(req: IfaceReq) -> dict[str, Any]:
            iface = await _wifi_iface(req.iface)
            link = await _link(iface)
            aps = await _scan(iface)
            ssid = link.get("ssid")
            candidates = [a for a in aps if ssid and a["ssid"] == ssid]
            for a in candidates:
                a["current"] = (a["bssid"] == link.get("bssid"))
            best = candidates[0] if candidates else None
            roam_suggested = bool(
                best and link.get("signal_dbm") is not None and best.get("signal_dbm") is not None
                and not best.get("current") and best["signal_dbm"] - link["signal_dbm"] >= 8
            )
            return {"ok": True, "iface": iface, "current": link, "ssid": ssid,
                    "candidates": candidates, "roam_suggested": roam_suggested,
                    "best_bssid": best["bssid"] if best else None}

        # ----- A6: walk-test signal tracker (heatmap / dead-zone finder) -----
        @r.post("/walk/sample")
        async def walk_sample_ep(req: WalkReq) -> dict[str, Any]:
            """Record one RSSI sample at the current spot (tag it with a room/waypoint label)."""
            iface = await _wifi_iface(req.iface)
            link = await _link(iface)
            tb = req.target_bssid.lower() if req.target_bssid else None
            target_ssid = req.target_ssid or (link.get("ssid") if link.get("connected") else None)
            # Fast path: sampling the currently-associated AP -> live link RSSI (no scan, no conflict).
            if link.get("connected") and not tb and target_ssid == link.get("ssid"):
                rssi, bssid, channel, aps_visible = link.get("signal_dbm"), link.get("bssid"), None, None
            else:
                aps = await _scan(iface)
                matches = [a for a in aps if (tb and a["bssid"] == tb) or (target_ssid and a["ssid"] == target_ssid)]
                best = max(matches, key=lambda a: (a["signal_dbm"] if a["signal_dbm"] is not None else -999), default=None)
                rssi = best["signal_dbm"] if best else None
                bssid = best["bssid"] if best else None
                channel = best["channel"] if best else None
                aps_visible = len(aps)
            sample = {"ts": int(time.time()), "label": req.label, "target": (tb or target_ssid),
                      "rssi_dbm": rssi, "zone": _zone(rssi), "bssid": bssid,
                      "channel": channel, "aps_visible": aps_visible}
            with open(_walk_file(), "a") as f:
                f.write(json.dumps(sample) + "\n")
            return {"ok": True, "sample": sample}

        @r.get("/walk/trace")
        def walk_trace_ep() -> dict[str, Any]:
            """The recorded trace + coverage summary (the heatmap data; dead-zone count)."""
            p = _walk_file()
            samples = []
            if p.exists():
                for line in p.read_text().splitlines():
                    try:
                        samples.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            rssis = [s["rssi_dbm"] for s in samples if s.get("rssi_dbm") is not None]
            zones: dict[str, int] = {}
            for s in samples:
                zones[s["zone"]] = zones.get(s["zone"], 0) + 1
            summary = {"count": len(samples), "zones": zones, "dead_zones": zones.get("dead", 0),
                       "min_dbm": min(rssis) if rssis else None, "max_dbm": max(rssis) if rssis else None,
                       "avg_dbm": round(sum(rssis) / len(rssis), 1) if rssis else None}
            return {"ok": True, "summary": summary, "samples": samples[-500:]}

        @r.post("/walk/reset")
        def walk_reset_ep() -> dict[str, Any]:
            p = _walk_file()
            if p.exists():
                p.unlink()
            return {"ok": True, "reset": True}

        return r
