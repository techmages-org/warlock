"""Net Diag — Fluke/LinkRunner-class network diagnostics (Track A / A1).

Blue-team, *local-by-default* link & path qualification for the deck's own
interfaces — the kind of one-button answer a Fluke LinkRunner gives a tech:

  POST /api/netdiag/link        — interface link: speed/duplex/carrier (ethtool) or
                                  Wi-Fi signal/bitrate/SSID/freq (iw)
  POST /api/netdiag/neighbors   — LLDP/CDP nearest-switch + port + VLAN (lldpctl -f json)
  POST /api/netdiag/services    — DHCP lease + default gateway + DNS resolution health
  POST /api/netdiag/path        — gateway reachability (loss/rtt), mtr hop path, path-MTU
  POST /api/netdiag/throughput  — iperf3 to a server (engagement-gated for non-RFC1918 servers)
  POST /api/netdiag/health      — ONE-BUTTON roll-up: link + services + path → PASS/WARN/FAIL
  GET  /api/netdiag/status      — primary iface, gateway, and which tools are available

Everything is passive/local and needs no engagement EXCEPT throughput to a
non-local (non-RFC1918) iperf server, which is gated exactly like net_recon's
non-local scans. Missing tools degrade to ``available:false`` rather than crash,
so the module still imports on a dev host that lacks ethtool/iw/lldpctl.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import shutil
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import AuditEntry
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.netdiag")

# Tools that commonly live in /usr/sbin and need root.
_SEARCH = ("/usr/sbin", "/sbin", "/usr/bin", "/bin")


def _tool(name: str) -> str | None:
    """Resolve a binary by name across PATH + the usual sbin dirs."""
    p = shutil.which(name)
    if p:
        return p
    for d in _SEARCH:
        cand = os.path.join(d, name)
        if os.path.exists(cand):
            return cand
    return None


async def _run(argv: list[str], timeout: float = 20.0, sudo: bool = False) -> tuple[int, str, str]:
    """Run argv; return (rc, stdout, stderr). rc=-1 on missing binary, -2 on timeout."""
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
        return -2, "", f"{argv[0]} timed out after {timeout}s"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _audit(kind: str, command: str, target: str, note: str, outcome: str) -> None:
    """Durable AuditEntry + best-effort signed AAR — mirrors net_recon._audit."""
    try:
        with session_scope() as s:
            s.add(AuditEntry(
                engagement_id=engagement.engagement_id, kind=kind, command=command,
                sha256=_sha256(command), target=target, note=note, outcome=outcome,
            ))
    except Exception:  # noqa: BLE001 — audit must never break a diagnostic
        log.warning("netdiag audit write failed (non-fatal)", exc_info=True)
    try:
        from warlock import aar
        aar.safe_emit_for_audit(kind=kind, command=command, target=target, note=note, outcome=outcome)
    except Exception:  # noqa: BLE001
        log.debug("netdiag AAR emit skipped", exc_info=True)


def _is_rfc1918(target: str) -> bool:
    t = target.split("/")[0].split(":")[0]
    try:
        return ipaddress.ip_address(t).is_private
    except ValueError:
        return False


# ----- primitives (each returns a self-describing dict, never raises) ---------

async def _default_route() -> dict[str, Any]:
    rc, out, _ = await _run([_tool("ip"), "route", "show", "default"], timeout=6)
    gw = iface = None
    if rc == 0:
        m = re.search(r"default via (\S+) dev (\S+)", out)
        if m:
            gw, iface = m.group(1), m.group(2)
    return {"gateway": gw, "iface": iface}


def _sys_link(iface: str) -> dict[str, Any]:
    base = f"/sys/class/net/{iface}"
    def _rd(f: str) -> str | None:
        try:
            return open(os.path.join(base, f)).read().strip()
        except OSError:
            return None
    return {
        "carrier": _rd("carrier") == "1",
        "operstate": _rd("operstate"),
        "speed_mbps": (int(_rd("speed")) if (_rd("speed") or "").lstrip("-").isdigit() else None),
        "mtu": (int(_rd("mtu")) if (_rd("mtu") or "").isdigit() else None),
    }


async def _link(iface: str) -> dict[str, Any]:
    """Wired link (ethtool) + Wi-Fi link (iw) + /sys fallback."""
    res: dict[str, Any] = {"iface": iface, **_sys_link(iface)}
    # wired
    rc, out, _ = await _run([_tool("ethtool"), iface], timeout=8, sudo=True)
    if rc == 0:
        def g(pat: str) -> str | None:
            m = re.search(pat, out)
            return m.group(1).strip() if m else None
        res["wired"] = {
            "speed": g(r"Speed:\s*(.+)"),
            "duplex": g(r"Duplex:\s*(.+)"),
            "link_detected": (g(r"Link detected:\s*(\w+)") == "yes"),
            "port": g(r"Port:\s*(.+)"),
        }
    # wireless
    rc, out, _ = await _run([_tool("iw"), "dev", iface, "link"], timeout=8, sudo=True)
    if rc == 0 and "Not connected" not in out:
        def gw_(pat: str) -> str | None:
            m = re.search(pat, out)
            return m.group(1).strip() if m else None
        res["wifi"] = {
            "ssid": gw_(r"SSID:\s*(.+)"),
            "freq_mhz": gw_(r"freq:\s*([\d.]+)"),
            "signal_dbm": gw_(r"signal:\s*(-?\d+)"),
            "tx_bitrate": gw_(r"tx bitrate:\s*(.+)"),
        }
    return res


async def _neighbors() -> dict[str, Any]:
    rc, out, err = await _run([_tool("lldpctl"), "-f", "json"], timeout=12, sudo=True)
    if rc != 0:
        return {"available": rc != -1, "neighbors": [], "note": err.strip()[:120] or "no lldpd"}
    try:
        data = json.loads(out or "{}")
    except json.JSONDecodeError:
        return {"available": True, "neighbors": [], "note": "unparseable lldp json"}
    ifaces = (data.get("lldp") or {}).get("interface") or {}
    if isinstance(ifaces, dict):
        ifaces = [{"name": k, **v} for k, v in ifaces.items()]
    neigh = []
    for it in (ifaces if isinstance(ifaces, list) else []):
        chassis = it.get("chassis") or {}
        name = next(iter(chassis), None) if isinstance(chassis, dict) else None
        port = it.get("port") or {}
        vlan = it.get("vlan") or {}
        neigh.append({
            "local_port": it.get("name"),
            "switch": name,
            "port_id": (port.get("id") or {}).get("value") if isinstance(port.get("id"), dict) else port.get("id"),
            "port_descr": (port.get("descr") if isinstance(port.get("descr"), str) else None),
            "vlan": (vlan.get("vlan-id") if isinstance(vlan, dict) else vlan),
        })
    return {"available": True, "neighbors": neigh}


async def _dns(name: str = "cloudflare.com", timeout: float = 3.0) -> dict[str, Any]:
    dig = _tool("dig")
    if not dig:
        return {"available": False, "resolved": None}
    loop = asyncio.get_event_loop()
    t0 = loop.time()
    rc, out, _ = await _run([dig, "+short", "+time=2", "+tries=1", name], timeout=timeout)
    ms = round((loop.time() - t0) * 1000)
    answers = [ln for ln in out.splitlines() if ln and not ln.startswith(";")]
    return {"available": True, "name": name, "resolved": bool(answers), "answers": answers[:4], "ms": ms}


async def _gateway_ping(gw: str | None, count: int = 4) -> dict[str, Any]:
    if not gw:
        return {"available": False, "note": "no default gateway"}
    rc, out, _ = await _run([_tool("ping"), "-c", str(count), "-W", "2", gw], timeout=count * 2 + 6)
    loss = re.search(r"(\d+(?:\.\d+)?)% packet loss", out)
    rtt = re.search(r"=\s*[\d.]+/([\d.]+)/([\d.]+)/([\d.]+)", out)
    return {
        "available": True, "gateway": gw,
        "loss_pct": float(loss.group(1)) if loss else 100.0,
        "rtt_avg_ms": float(rtt.group(1)) if rtt else None,
        "rtt_max_ms": float(rtt.group(2)) if rtt else None,
        "jitter_ms": float(rtt.group(3)) if rtt else None,
    }


async def _mtr(target: str, count: int = 5) -> dict[str, Any]:
    mtr = _tool("mtr")
    if not mtr:
        return {"available": False, "hops": []}
    rc, out, _ = await _run([mtr, "-j", "-c", str(count), target], timeout=count * 3 + 10)
    try:
        hubs = (json.loads(out).get("report") or {}).get("hubs") or []
    except (json.JSONDecodeError, AttributeError):
        return {"available": True, "hops": [], "note": "mtr parse error"}
    hops = [{"hop": h.get("count"), "host": h.get("host"), "loss_pct": h.get("Loss%"),
             "avg_ms": h.get("Avg")} for h in hubs]
    return {"available": True, "target": target, "hops": hops, "hop_count": len(hops)}


async def _path_mtu(target: str = "1.1.1.1") -> dict[str, Any]:
    """DF-bit bisection with plain ping (no tracepath needed)."""
    ping = _tool("ping")
    if not ping:
        return {"available": False, "path_mtu": None}
    lo, hi, best = 1200, 1472, None
    while lo <= hi:
        mid = (lo + hi) // 2
        rc, _o, _e = await _run([ping, "-M", "do", "-s", str(mid), "-c", "1", "-W", "2", target], timeout=6)
        if rc == 0:
            best = mid + 28  # + IP(20)+ICMP(8)
            lo = mid + 1
        else:
            hi = mid - 1
    return {"available": True, "target": target, "path_mtu": best}


async def _iperf(server: str, secs: int = 5) -> dict[str, Any]:
    ip3 = _tool("iperf3")
    if not ip3:
        return {"available": False}
    rc, out, err = await _run([ip3, "-c", server, "-t", str(secs), "-J"], timeout=secs + 15)
    if rc != 0:
        return {"available": True, "ok": False, "note": (err or out).strip()[:160]}
    try:
        end = json.loads(out).get("end", {})
        recv = (end.get("sum_received") or {}).get("bits_per_second")
        send = (end.get("sum_sent") or {}).get("bits_per_second")
    except json.JSONDecodeError:
        return {"available": True, "ok": False, "note": "iperf parse error"}
    return {"available": True, "ok": True, "server": server,
            "down_mbps": round((recv or 0) / 1e6, 1), "up_mbps": round((send or 0) / 1e6, 1)}


# ----- A10: link integrity (error counters, duplex mismatch, flap) -----------

_ERR_HINTS = ("err", "crc", "fcs", "align", "drop", "collision", "underrun",
              "overrun", "fifo", "missed", "runt", "jabber", "length", "carrier_sense")


async def _ethtool_errors(iface: str) -> dict[str, Any]:
    rc, out, _ = await _run([_tool("ethtool"), "-S", iface], timeout=8, sudo=True)
    if rc != 0:
        return {"available": False}
    counters: dict[str, int] = {}
    for line in out.splitlines():
        k, sep, v = line.strip().partition(":")
        v = v.strip()
        if sep and v.lstrip("-").isdigit() and any(h in k for h in _ERR_HINTS):
            counters[k] = int(v)
    late = sum(v for k, v in counters.items() if "late_collision" in k)
    colls = sum(v for k, v in counters.items() if "collision" in k)
    return {"available": True, "nonzero": {k: v for k, v in counters.items() if v},
            "late_collisions": late, "collisions_total": colls, "counter_count": len(counters)}


def _kernel_errors(iface: str) -> dict[str, Any]:
    base = f"/sys/class/net/{iface}/statistics"

    def rd(n: str) -> int | None:
        try:
            return int(open(os.path.join(base, n)).read().strip())
        except OSError:
            return None

    return {k: rd(k) for k in ("rx_errors", "tx_errors", "rx_dropped", "tx_dropped",
                               "rx_crc_errors", "rx_frame_errors", "rx_fifo_errors",
                               "collisions", "rx_missed_errors")}


def _flap_counters(iface: str) -> dict[str, Any]:
    base = f"/sys/class/net/{iface}"

    def rd(n: str) -> str | None:
        try:
            return open(os.path.join(base, n)).read().strip()
        except OSError:
            return None

    def num(n: str) -> int | None:
        v = rd(n)
        return int(v) if (v or "").isdigit() else None

    return {"carrier": rd("carrier") == "1", "carrier_changes": num("carrier_changes"),
            "carrier_up_count": num("carrier_up_count"), "carrier_down_count": num("carrier_down_count")}


# ----- A9: service & WAN health (rogue-DHCP, NTP/GPS, captive-portal) ---------

async def _dhcp_scan(iface: str) -> dict[str, Any]:
    rc, out, _ = await _run([_tool("nmap"), "--script", "broadcast-dhcp-discover", "-e", iface],
                            sudo=True, timeout=45)
    servers: list[dict[str, Any]] = []
    cur: dict[str, Any] = {}
    for line in out.splitlines():
        s = line.strip().lstrip("|_").strip()
        if s.startswith("IP Offered:"):
            cur = {"offered": s.split(":", 1)[1].strip()}
        elif s.startswith("Router:"):
            cur["router"] = s.split(":", 1)[1].strip()
        elif s.startswith("Domain Name Server:"):
            cur["dns"] = s.split(":", 1)[1].strip()
        elif s.startswith("Server Identifier:"):
            cur["server"] = s.split(":", 1)[1].strip()
            servers.append(cur)
            cur = {}
    uniq = sorted({sv["server"] for sv in servers if sv.get("server")})
    rogue = len(uniq) > 1
    return {"available": rc == 0, "servers": servers, "server_count": len(uniq), "rogue_dhcp": rogue,
            "verdict": "FAIL" if rogue else ("PASS" if uniq else "WARN"),
            "note": (f"MULTIPLE DHCP servers {uniq} — ROGUE DHCP on the segment" if rogue
                     else (f"single DHCP server {uniq[0]}" if uniq else "no DHCP offer seen"))}


async def _ntp_check() -> dict[str, Any]:
    rc, out, _ = await _run([_tool("chronyc"), "tracking"], timeout=6)
    if rc != 0:
        return {"available": False, "note": "chronyc unavailable"}

    def g(p: str) -> str | None:
        m = re.search(p, out)
        return m.group(1).strip() if m else None

    strat = g(r"Stratum\s*:\s*(\d+)")
    last = g(r"Last offset\s*:\s*([-\d.]+)")
    synced = strat is not None and int(strat) < 16
    off = abs(float(last)) if last else None
    return {"available": True, "reference": g(r"Reference ID\s*:\s*(.+)"),
            "stratum": int(strat) if strat else None, "last_offset_s": float(last) if last else None,
            "verdict": "PASS" if (synced and (off is None or off < 0.1)) else ("WARN" if synced else "FAIL"),
            "note": (f"synced, stratum {strat}, offset {last}s" if synced else "NOT synced to a time source")}


async def _wan_check() -> dict[str, Any]:
    url = "http://connectivitycheck.gstatic.com/generate_204"
    rc, out, _ = await _run([_tool("curl"), "-s", "-o", "/dev/null", "-w", "%{http_code}",
                             "--max-time", "6", url], timeout=10)
    code = out.strip()
    return {"available": _tool("curl") is not None, "http_code": code,
            "internet": code in ("204", "200"),
            "captive_portal_suspected": bool(code) and code != "204",
            "verdict": "PASS" if code == "204" else ("WARN" if code else "FAIL"),
            "note": ("internet OK, no captive portal" if code == "204"
                     else (f"unexpected HTTP {code} — possible captive portal / proxy" if code
                           else "no WAN response — internet down?"))}


# ----- verdict roll-up (LinkRunner-style PASS/WARN/FAIL) ----------------------

def _rollup(link: dict, svc: dict, path: dict) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def add(name: str, verdict: str, detail: str) -> None:
        checks.append({"check": name, "verdict": verdict, "detail": detail})

    # link
    carrier = link.get("carrier") or (link.get("wifi") is not None) or \
        ((link.get("wired") or {}).get("link_detected"))
    add("link", "PASS" if carrier else "FAIL",
        link.get("wifi", {}).get("ssid") or (link.get("wired") or {}).get("speed") or link.get("operstate") or "down")
    # gateway / latency
    gp = svc.get("gateway") or {}
    if gp.get("available"):
        loss, rtt = gp.get("loss_pct", 100.0), gp.get("rtt_avg_ms")
        v = "PASS" if loss == 0 and (rtt or 999) < 30 else ("FAIL" if loss >= 100 else "WARN")
        add("gateway", v, f"{loss:g}% loss, rtt {rtt}ms")
    # dns
    dns = svc.get("dns") or {}
    if dns.get("available"):
        v = "PASS" if dns.get("resolved") and (dns.get("ms") or 999) < 300 else ("FAIL" if not dns.get("resolved") else "WARN")
        add("dns", v, f"resolved={dns.get('resolved')} in {dns.get('ms')}ms")
    # dhcp / addressing
    dh = svc.get("dhcp") or {}
    add("dhcp", "PASS" if dh.get("has_lease") else "WARN", dh.get("detail", ""))
    # path-mtu
    pm = path.get("path_mtu") or {}
    if pm.get("available"):
        v = "PASS" if (pm.get("path_mtu") or 0) >= 1500 else "WARN"
        add("path_mtu", v, str(pm.get("path_mtu")))

    order = {"FAIL": 2, "WARN": 1, "PASS": 0}
    overall = "PASS"
    for c in checks:
        if order[c["verdict"]] > order[overall]:
            overall = c["verdict"]
    return {"overall": overall, "checks": checks}


# ----- request models --------------------------------------------------------

class IfaceReq(BaseModel):
    iface: str | None = Field(default=None, description="interface; default = primary (default route)")


class PathReq(BaseModel):
    target: str = "1.1.1.1"
    count: int = Field(default=5, ge=1, le=20)


class ThroughputReq(BaseModel):
    server: str
    secs: int = Field(default=5, ge=1, le=30)


class FlapReq(IfaceReq):
    watch_secs: int = Field(default=0, ge=0, le=30)


class HealthReq(BaseModel):
    iface: str | None = None
    target: str = "1.1.1.1"
    dns_name: str = "cloudflare.com"


# ----- module ----------------------------------------------------------------

class Module(ModuleBase):
    id = "netdiag"
    label = "Net Diag"
    icon = "⌁"
    requires_engagement = False  # local link/path qualification — blue-team

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        async def _iface_or_default(iface: str | None) -> str:
            if iface:
                return iface
            dr = await _default_route()
            if not dr.get("iface"):
                raise HTTPException(503, "no default-route interface; pass iface explicitly")
            return dr["iface"]

        @r.get("/status")
        async def status_ep() -> dict[str, Any]:
            dr = await _default_route()
            tools = {t: bool(_tool(t)) for t in ("ip", "ethtool", "iw", "lldpctl", "dig", "mtr", "ping", "iperf3")}
            return {"ok": True, **dr, "tools": tools,
                    "checks": ["link", "neighbors", "services", "path", "throughput", "health"]}

        @r.post("/link")
        async def link_ep(req: IfaceReq) -> dict[str, Any]:
            return {"ok": True, "link": await _link(await _iface_or_default(req.iface))}

        @r.post("/neighbors")
        async def neighbors_ep() -> dict[str, Any]:
            return {"ok": True, **(await _neighbors())}

        @r.post("/services")
        async def services_ep() -> dict[str, Any]:
            dr = await _default_route()
            iface, gw = dr.get("iface"), dr.get("gateway")
            dns = await _dns()
            gp = await _gateway_ping(gw)
            has_lease = bool(gw and iface and _sys_link(iface or "").get("carrier") is not None)
            return {"ok": True,
                    "dhcp": {"has_lease": bool(gw), "gateway": gw, "iface": iface,
                             "detail": f"gw {gw} via {iface}" if gw else "no default route"},
                    "dns": dns, "gateway": gp}

        @r.post("/path")
        async def path_ep(req: PathReq) -> dict[str, Any]:
            dr = await _default_route()
            return {"ok": True,
                    "gateway": await _gateway_ping(dr.get("gateway"), req.count),
                    "mtr": await _mtr(req.target, req.count),
                    "path_mtu": await _path_mtu(req.target)}

        @r.post("/throughput")
        async def throughput_ep(req: ThroughputReq) -> dict[str, Any]:
            # iperf to a NON-local server keys the engagement gate (active, leaves the segment).
            if not _is_rfc1918(req.server):
                if not engagement.is_on():
                    _audit("netdiag.throughput", f"iperf3 -c {req.server}", req.server,
                           "engagement-off", "refused")
                    raise HTTPException(403, "engagement OFF — iperf to a non-local server requires an active engagement")
                if not engagement.check_target(req.server):
                    _audit("netdiag.throughput", f"iperf3 -c {req.server}", req.server,
                           "scope-violation", "refused")
                    raise HTTPException(403, f"target {req.server!r} not in engagement scope")
            res = await _iperf(req.server, req.secs)
            _audit("netdiag.throughput", f"iperf3 -c {req.server} -t {req.secs}", req.server,
                   json.dumps(res)[:240], "success" if res.get("ok") else "error")
            return {"ok": True, "throughput": res}

        @r.post("/health")
        async def health_ep(req: HealthReq) -> dict[str, Any]:
            """One-button wired/wireless health — the LinkRunner verdict."""
            dr = await _default_route()
            iface = req.iface or dr.get("iface")
            if not iface:
                raise HTTPException(503, "no interface to test")
            link = await _link(iface)
            svc = {
                "dhcp": {"has_lease": bool(dr.get("gateway")), "gateway": dr.get("gateway"),
                         "detail": f"gw {dr.get('gateway')} via {iface}" if dr.get("gateway") else "no lease"},
                "dns": await _dns(req.dns_name),
                "gateway": await _gateway_ping(dr.get("gateway")),
            }
            path = {"path_mtu": await _path_mtu(req.target)}
            verdict = _rollup(link, svc, path)
            _audit("netdiag.health", f"health iface={iface} target={req.target}", iface,
                   f"overall={verdict['overall']}", verdict["overall"].lower())
            return {"ok": True, "iface": iface, "verdict": verdict,
                    "link": link, "services": svc, "path": path}

        @r.post("/errors")
        async def errors_ep(req: IfaceReq) -> dict[str, Any]:
            """Interface error counters + duplex-mismatch heuristic (late collisions)."""
            iface = await _iface_or_default(req.iface)
            eth = await _ethtool_errors(iface)
            kern = _kernel_errors(iface)
            late = eth.get("late_collisions", 0) or 0
            err_present = bool(eth.get("nonzero")) or any(
                (v or 0) for k, v in kern.items() if "error" in k or "crc" in k)
            verdict = "FAIL" if late > 0 else ("WARN" if err_present else "PASS")
            notes = []
            if late > 0:
                notes.append(f"{late} late collisions — possible DUPLEX MISMATCH / cabling fault")
            elif err_present:
                notes.append("interface errors present — inspect cable / port / SFP")
            return {"ok": True, "iface": iface, "verdict": verdict,
                    "duplex": (await _link(iface)).get("wired", {}).get("duplex"),
                    "ethtool": eth, "kernel": kern, "notes": notes}

        @r.post("/flap")
        async def flap_ep(req: FlapReq) -> dict[str, Any]:
            """Link-flap detector — cumulative carrier transitions + optional live watch."""
            iface = await _iface_or_default(req.iface)
            before = _flap_counters(iface)
            window = None
            if req.watch_secs:
                await asyncio.sleep(req.watch_secs)
                after = _flap_counters(iface)
                window = {"secs": req.watch_secs,
                          "new_changes": (after.get("carrier_changes") or 0) - (before.get("carrier_changes") or 0)}
            ch = before.get("carrier_changes")
            if window and window["new_changes"] > 0:
                verdict = "FAIL"
                note = f"{window['new_changes']} flap(s) during a {req.watch_secs}s watch — LINK IS FLAPPING"
            elif ch == 0:
                verdict, note = "PASS", "stable — no carrier transitions since boot"
            else:
                verdict = "WARN"
                note = f"{ch} carrier transitions since boot ({before.get('carrier_down_count')} down) — investigate if unexpected"
            return {"ok": True, "iface": iface, "verdict": verdict, "flap": before, "window": window, "note": note}

        @r.post("/dhcp_scan")
        async def dhcp_scan_ep(req: IfaceReq) -> dict[str, Any]:
            """Active DHCP discovery + ROGUE-DHCP detection (multiple servers on the segment)."""
            iface = await _iface_or_default(req.iface)
            res = await _dhcp_scan(iface)
            _audit("netdiag.dhcp_scan", f"broadcast-dhcp-discover {iface}", iface,
                   res.get("note", ""), "success" if res.get("available") else "error")
            return {"ok": True, "iface": iface, **res}

        @r.post("/ntp")
        async def ntp_ep() -> dict[str, Any]:
            """Time-sync health (chrony) — offset/stratum; the deck's GPS makes it a reference clock."""
            return {"ok": True, **(await _ntp_check())}

        @r.post("/wan")
        async def wan_ep() -> dict[str, Any]:
            """Internet reachability + captive-portal detection (generate_204)."""
            return {"ok": True, **(await _wan_check())}

        return r
