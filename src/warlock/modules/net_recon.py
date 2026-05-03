"""Net Recon — LAN host discovery + nmap-driven port scans.

Backend exposes:
  GET    /api/net_recon/status          — current LAN summary
  POST   /api/net_recon/arpscan         — sweep current subnet (ARP/ICMP, no engagement gate)
  GET    /api/net_recon/hosts           — cumulative hosts seen (sorted by last_seen desc)
  GET    /api/net_recon/host/{ip}       — single host detail
  POST   /api/net_recon/portscan        — body: {targets, profile} (engagement-gated for non-RFC1918)
  GET    /api/net_recon/scans           — recent scan jobs
  GET    /api/net_recon/scan/{id}       — full scan record
  DELETE /api/net_recon/scan/{id}       — remove a scan record

Discovery uses ``nmap -sn -PR`` (ARP-based) so it does not depend on the
optional ``arp-scan`` package. Port scan profiles invoke ``nmap -oX -`` and
parse the XML inline.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import shutil
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import desc

from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import Host, Scan
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.net_recon")

# nmap profile presets — keyed argv (without target).
PROFILES: dict[str, list[str]] = {
    "quick":   ["-T4", "-F"],                                  # top 100 ports
    "top1000": ["-T4", "--top-ports", "1000"],
    "full":    ["-T4", "-p-"],
    "service": ["-T4", "-sV", "-sC", "--top-ports", "1000"],
    "vuln":    ["-T4", "--script", "vuln", "--top-ports", "1000"],
}


def _primary_iface_subnet() -> tuple[str | None, str | None]:
    """Return (subnet_cidr, gateway_ip) for the default-route interface."""
    if not shutil.which("ip"):
        return None, None
    try:
        out = subprocess.run(
            ["ip", "-4", "route", "show", "default"], capture_output=True, text=True, timeout=2
        )
        gw = None
        dev = None
        for line in out.stdout.splitlines():
            parts = line.split()
            if "via" in parts and "dev" in parts:
                gw = parts[parts.index("via") + 1]
                dev = parts[parts.index("dev") + 1]
                break
        if not dev:
            return None, gw
        out2 = subprocess.run(
            ["ip", "-4", "addr", "show", "dev", dev], capture_output=True, text=True, timeout=2
        )
        for line in out2.stdout.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                cidr = line.split()[1]
                # Normalize to network address (e.g. 192.168.100.77/24 → 192.168.100.0/24)
                try:
                    net = ipaddress.ip_network(cidr, strict=False)
                    return str(net), gw
                except ValueError:
                    return cidr, gw
        return None, gw
    except Exception:  # noqa: BLE001
        return None, None


def _is_rfc1918(target: str) -> bool:
    """Best-effort RFC1918 check; returns False for unparseable strings."""
    t = target.split("/")[0]
    try:
        ip = ipaddress.ip_address(t)
        return ip.is_private
    except ValueError:
        try:
            net = ipaddress.ip_network(target, strict=False)
            return net.network_address.is_private
        except ValueError:
            return False


def _parse_nmap_xml(xml_text: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (hosts, summary). hosts: list of {ip, mac, vendor, hostname, ports[], os_guess}."""
    hosts: list[dict[str, Any]] = []
    summary: dict[str, Any] = {"up": 0, "down": 0, "total": 0}
    if not xml_text.strip():
        return hosts, summary
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        summary["parse_error"] = str(e)
        return hosts, summary
    for h in root.findall("host"):
        st = h.find("status")
        state = st.get("state") if st is not None else ""
        summary["total"] += 1
        if state == "up":
            summary["up"] += 1
        else:
            summary["down"] += 1
            continue
        ip = ""
        mac = ""
        vendor = ""
        for addr in h.findall("address"):
            atype = addr.get("addrtype", "")
            if atype == "ipv4" and not ip:
                ip = addr.get("addr", "")
            elif atype == "mac":
                mac = addr.get("addr", "").lower()
                vendor = addr.get("vendor", "")
        hostname = ""
        hn = h.find("hostnames/hostname")
        if hn is not None:
            hostname = hn.get("name", "")
        ports: list[dict[str, Any]] = []
        for p in h.findall("ports/port"):
            pst = p.find("state")
            if pst is None or pst.get("state") not in ("open", "open|filtered"):
                continue
            svc = p.find("service")
            ports.append({
                "port": int(p.get("portid", "0") or 0),
                "proto": p.get("protocol", "tcp"),
                "state": pst.get("state", ""),
                "service": svc.get("name", "") if svc is not None else "",
                "product": svc.get("product", "") if svc is not None else "",
                "version": svc.get("version", "") if svc is not None else "",
            })
        os_guess = ""
        osm = h.find("os/osmatch")
        if osm is not None:
            os_guess = osm.get("name", "")
        if ip:
            hosts.append({
                "ip": ip, "mac": mac, "vendor": vendor, "hostname": hostname,
                "ports": ports, "os_guess": os_guess,
            })
    return hosts, summary


async def _run_nmap(argv: list[str], timeout: float = 1800.0) -> str:
    """Run nmap with -oX -, return XML text. Raises HTTPException on failure."""
    full = ["sudo", "-n", "nmap", "-oX", "-", *argv]
    proc = await asyncio.create_subprocess_exec(
        *full, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "nmap timed out") from None
    if proc.returncode != 0:
        # Fall back without sudo (some scans don't need raw sockets)
        proc2 = await asyncio.create_subprocess_exec(
            "nmap", "-oX", "-", *argv,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc2.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc2.kill()
            raise HTTPException(504, "nmap timed out") from None
        if proc2.returncode != 0:
            raise HTTPException(500, f"nmap failed: {stderr.decode(errors='replace').strip()[:300]}")
    return stdout.decode(errors="replace")


def _upsert_hosts(rows: list[dict[str, Any]]) -> int:
    """Merge scan results into the Host table. Returns count of rows upserted."""
    n = 0
    now = datetime.utcnow()
    with session_scope() as s:
        for r in rows:
            ip = r.get("ip") or ""
            if not ip:
                continue
            existing = s.get(Host, ip)
            if existing is None:
                s.add(Host(
                    ip=ip,
                    mac=r.get("mac", ""),
                    vendor=r.get("vendor", ""),
                    hostname=r.get("hostname", ""),
                    ports=r.get("ports", []),
                    os_guess=r.get("os_guess", ""),
                    first_seen=now,
                    last_seen=now,
                ))
            else:
                if r.get("mac"):
                    existing.mac = r["mac"]
                if r.get("vendor"):
                    existing.vendor = r["vendor"]
                if r.get("hostname"):
                    existing.hostname = r["hostname"]
                if r.get("os_guess"):
                    existing.os_guess = r["os_guess"]
                # Merge ports — keep union by (port,proto)
                old = {(p["port"], p.get("proto", "tcp")): p for p in (existing.ports or [])}
                for p in r.get("ports", []):
                    old[(p["port"], p.get("proto", "tcp"))] = p
                existing.ports = sorted(old.values(), key=lambda p: (p.get("proto", "tcp"), p["port"]))
                existing.last_seen = now
            n += 1
    return n


class PortScanBody(BaseModel):
    targets: list[str] = Field(..., min_length=1)
    profile: str = Field(default="quick")


class Module(ModuleBase):
    id = "net_recon"
    label = "Net Recon"
    icon = "⚘"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status_ep() -> dict[str, Any]:
            subnet, gw = _primary_iface_subnet()
            with session_scope() as s:
                hosts = s.query(Host).count()
                last = s.query(Scan).order_by(desc(Scan.started_at)).first()
                last_scan = None
                if last is not None:
                    last_scan = {
                        "id": last.id, "target": last.target, "profile": last.profile,
                        "status": last.status, "started_at": last.started_at.isoformat() if last.started_at else None,
                        "hosts_found": last.hosts_found,
                    }
            return {
                "ok": True,
                "subnet": subnet,
                "gateway": gw,
                "hosts_seen": hosts,
                "last_scan": last_scan,
                "profiles": list(PROFILES.keys()),
            }

        @r.post("/arpscan")
        async def arpscan() -> dict[str, Any]:
            subnet, _gw = _primary_iface_subnet()
            if not subnet:
                raise HTTPException(503, "could not determine local subnet")
            xml_text = await _run_nmap(["-sn", "-PR", subnet], timeout=120.0)
            hosts, summary = _parse_nmap_xml(xml_text)
            n = _upsert_hosts(hosts)
            with session_scope() as s:
                s.add(Scan(
                    target=subnet, profile="arpscan", status="success",
                    started_at=datetime.utcnow(), finished_at=datetime.utcnow(),
                    hosts_found=summary.get("up", 0), summary=summary, raw_xml="",
                    engagement_id=engagement.engagement_id,
                ))
            return {"ok": True, "subnet": subnet, "summary": summary, "upserts": n, "hosts": hosts}

        @r.get("/hosts")
        def list_hosts(limit: int = 500) -> dict[str, Any]:
            limit = max(1, min(2000, int(limit)))
            with session_scope() as s:
                rows = s.query(Host).order_by(desc(Host.last_seen)).limit(limit).all()
                out = [{
                    "ip": h.ip, "mac": h.mac, "vendor": h.vendor, "hostname": h.hostname,
                    "ports": h.ports or [],
                    "os_guess": h.os_guess,
                    "first_seen": h.first_seen.isoformat() if h.first_seen else None,
                    "last_seen": h.last_seen.isoformat() if h.last_seen else None,
                    "note": h.note,
                } for h in rows]
            return {"ok": True, "hosts": out, "count": len(out)}

        @r.get("/host/{ip}")
        def get_host(ip: str) -> dict[str, Any]:
            with session_scope() as s:
                h = s.get(Host, ip)
                if h is None:
                    raise HTTPException(404, "host not in database")
                return {"ok": True, "host": {
                    "ip": h.ip, "mac": h.mac, "vendor": h.vendor, "hostname": h.hostname,
                    "ports": h.ports or [], "os_guess": h.os_guess,
                    "first_seen": h.first_seen.isoformat() if h.first_seen else None,
                    "last_seen": h.last_seen.isoformat() if h.last_seen else None,
                    "note": h.note,
                }}

        @r.post("/portscan")
        async def portscan(body: PortScanBody) -> dict[str, Any]:
            if body.profile not in PROFILES:
                raise HTTPException(400, f"unknown profile {body.profile!r}; choose one of {list(PROFILES)}")
            targets = [t.strip() for t in body.targets if t and t.strip()]
            if not targets:
                raise HTTPException(400, "targets required")

            # Engagement gate: required for any non-RFC1918 OR a CIDR with prefix < /24
            need_gate = False
            for t in targets:
                if not _is_rfc1918(t):
                    need_gate = True
                    break
                if "/" in t:
                    try:
                        net = ipaddress.ip_network(t, strict=False)
                        if net.prefixlen < 24:
                            need_gate = True
                            break
                    except ValueError:
                        pass
            if need_gate:
                if not engagement.is_on():
                    raise HTTPException(403, "engagement OFF — non-RFC1918 or wide CIDR scans require an active engagement")
                for t in targets:
                    if not engagement.check_target(t):
                        raise HTTPException(403, f"target {t!r} not in engagement scope")

            argv = PROFILES[body.profile] + targets
            scan_id: str | None = None
            with session_scope() as s:
                row = Scan(
                    target=",".join(targets), profile=body.profile, status="running",
                    engagement_id=engagement.engagement_id,
                )
                s.add(row); s.flush()
                scan_id = row.id

            try:
                xml_text = await _run_nmap(argv, timeout=3600.0)
                hosts, summary = _parse_nmap_xml(xml_text)
                n = _upsert_hosts(hosts)
                with session_scope() as s:
                    row = s.get(Scan, scan_id)
                    if row is not None:
                        row.status = "success"
                        row.finished_at = datetime.utcnow()
                        row.hosts_found = summary.get("up", 0)
                        row.summary = summary
                        # Truncate XML to keep DB small (raw_xml capped at 256 KB)
                        row.raw_xml = xml_text[:262_144]
                return {"ok": True, "scan_id": scan_id, "profile": body.profile, "summary": summary, "upserts": n, "hosts": hosts}
            except HTTPException as e:
                with session_scope() as s:
                    row = s.get(Scan, scan_id)
                    if row is not None:
                        row.status = "failed"
                        row.finished_at = datetime.utcnow()
                        row.summary = {"error": e.detail}
                raise

        @r.get("/scans")
        def list_scans(limit: int = 100) -> dict[str, Any]:
            limit = max(1, min(500, int(limit)))
            with session_scope() as s:
                rows = s.query(Scan).order_by(desc(Scan.started_at)).limit(limit).all()
                out = [{
                    "id": x.id, "target": x.target, "profile": x.profile, "status": x.status,
                    "started_at": x.started_at.isoformat() if x.started_at else None,
                    "finished_at": x.finished_at.isoformat() if x.finished_at else None,
                    "hosts_found": x.hosts_found,
                    "engagement_id": x.engagement_id,
                } for x in rows]
            return {"ok": True, "scans": out, "count": len(out)}

        @r.get("/scan/{scan_id}")
        def get_scan(scan_id: str) -> dict[str, Any]:
            with session_scope() as s:
                row = s.get(Scan, scan_id)
                if row is None:
                    raise HTTPException(404, "scan not found")
                # Re-parse hosts from raw_xml so the UI can show them, even after upsert merging.
                hosts: list[dict[str, Any]] = []
                if row.raw_xml:
                    hosts, _ = _parse_nmap_xml(row.raw_xml)
                return {"ok": True, "scan": {
                    "id": row.id, "target": row.target, "profile": row.profile, "status": row.status,
                    "started_at": row.started_at.isoformat() if row.started_at else None,
                    "finished_at": row.finished_at.isoformat() if row.finished_at else None,
                    "hosts_found": row.hosts_found, "summary": row.summary or {},
                    "engagement_id": row.engagement_id,
                    "hosts": hosts,
                }}

        @r.delete("/scan/{scan_id}")
        def delete_scan(scan_id: str) -> dict[str, Any]:
            with session_scope() as s:
                row = s.get(Scan, scan_id)
                if row is None:
                    raise HTTPException(404, "scan not found")
                s.delete(row)
            return {"ok": True, "deleted": scan_id}

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.net_recon import NetReconScreen
        return NetReconScreen()
