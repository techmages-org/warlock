"""Net Recon — LAN host discovery + nmap-driven port scans + blue-team monitoring.

Backend exposes:
  GET    /api/net_recon/status          — current LAN summary
  POST   /api/net_recon/arpscan         — sweep current subnet (ARP/ICMP, no engagement gate)
  GET    /api/net_recon/hosts           — cumulative hosts seen (sorted by last_seen desc)
  GET    /api/net_recon/host/{ip}       — single host detail
  POST   /api/net_recon/portscan        — body: {targets, profile} (engagement-gated for non-RFC1918)
  GET    /api/net_recon/scans           — recent scan jobs
  GET    /api/net_recon/scan/{id}       — full scan record
  DELETE /api/net_recon/scan/{id}       — remove a scan record

Blue-team / defensive monitoring (passive — your own network, no engagement gate):
  POST   /api/net_recon/baseline        — snapshot current hosts/services as the "known-good" baseline
  GET    /api/net_recon/baseline        — return the stored baseline snapshot
  POST   /api/net_recon/diff            — scan + diff vs baseline → new/changed/gone alerts
  GET    /api/net_recon/alerts          — the findings from the most recent diff

Discovery uses ``nmap -sn -PR`` (ARP-based) so it does not depend on the
optional ``arp-scan`` package. Port scan profiles invoke ``nmap -oX -`` and
parse the XML inline. The baseline + diff persist as JSON files under the
operator data root (``~/warlock/``) so no new DB model is required.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import shutil
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import desc

from warlock import events
from warlock.config import get_settings
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


class DefenseBody(BaseModel):
    """Body for baseline/diff. ``profile`` None → host-discovery sweep (``-sn -PR``);
    a PROFILES key → port-aware scan so new/gone *services* can be diffed too."""
    profile: str | None = Field(default=None)


# --------------------------------------------------------------------------- #
# Blue-team defensive monitoring: baseline snapshot + scan-diff alerting.
#
# A *snapshot* is built directly from one nmap run's parsed hosts. The baseline
# and the diff's "current" picture are built the SAME way, so new/gone hosts and
# new/gone services diff cleanly (symmetric). Both persist as JSON under the
# operator data root — no new DB model, no engagement gate (own-network monitoring
# mirrors the read-only arpscan route).
# --------------------------------------------------------------------------- #
def _baseline_path() -> Path:
    return get_settings().data / "net_recon_baseline.json"


def _alerts_path() -> Path:
    return get_settings().data / "net_recon_alerts.json"


def _save_json(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return None


def _build_snapshot(hosts: list[dict[str, Any]], *, subnet: str | None, profile: str | None) -> dict[str, Any]:
    """Turn parsed nmap hosts into a baseline/diff snapshot keyed by IP.

    ``host_discovery_only`` records whether this scan had port visibility — an
    ARP sweep (profile None) sees no services, so service-level diffs must be
    skipped against it (absence of port data is NOT "service gone")."""
    host_map: dict[str, Any] = {}
    svc_count = 0
    for h in hosts:
        ip = h.get("ip") or ""
        if not ip:
            continue
        svcs = [{
            "port": int(p.get("port", 0) or 0),
            "proto": p.get("proto", "tcp"),
            "service": p.get("service", ""),
            "product": p.get("product", ""),
            "version": p.get("version", ""),
        } for p in h.get("ports", [])]
        svc_count += len(svcs)
        host_map[ip] = {
            "ip": ip,
            "mac": (h.get("mac") or "").lower(),
            "vendor": h.get("vendor", ""),
            "hostname": h.get("hostname", ""),
            "os_guess": h.get("os_guess", ""),
            "services": svcs,
        }
    return {
        "created_at": datetime.utcnow().isoformat(),
        "subnet": subnet,
        "profile": profile or "arpscan",
        "host_discovery_only": profile is None,
        "host_count": len(host_map),
        "service_count": svc_count,
        "hosts": host_map,
    }


def _baseline_meta(snap: dict[str, Any]) -> dict[str, Any]:
    """Lightweight baseline summary (everything except the full host map)."""
    return {
        "created_at": snap.get("created_at"),
        "subnet": snap.get("subnet"),
        "profile": snap.get("profile"),
        "host_discovery_only": snap.get("host_discovery_only", True),
        "host_count": snap.get("host_count", len(snap.get("hosts", {}) or {})),
        "service_count": snap.get("service_count", 0),
    }


def _diff_snapshots(baseline: dict[str, Any], current: dict[str, Any]) -> list[dict[str, Any]]:
    """Pure diff: baseline vs current snapshot → list of alert findings.

    Findings: new_host / gone_host (host presence), new_service / gone_service
    (open-port surface, only when BOTH scans had port visibility), and
    mac_changed (same IP, different MAC → possible ARP spoof / device swap)."""
    alerts: list[dict[str, Any]] = []
    b_hosts: dict[str, Any] = baseline.get("hosts", {}) or {}
    c_hosts: dict[str, Any] = current.get("hosts", {}) or {}
    b_ips, c_ips = set(b_hosts), set(c_hosts)
    service_capable = (
        not baseline.get("host_discovery_only", True)
        and not current.get("host_discovery_only", True)
    )

    # New devices on the network — the headline blue-team signal.
    for ip in sorted(c_ips - b_ips):
        h = c_hosts[ip]
        vendor = h.get("vendor") or ""
        hostname = h.get("hostname") or ""
        label = f" ({vendor})" if vendor else (f" ({hostname})" if hostname else "")
        alerts.append({
            "type": "new_host", "severity": "warning", "ip": ip,
            "mac": h.get("mac", ""), "vendor": vendor, "hostname": hostname,
            "message": f"New device {ip}{label} appeared on the network",
        })

    # Devices from baseline that no longer respond.
    for ip in sorted(b_ips - c_ips):
        h = b_hosts[ip]
        alerts.append({
            "type": "gone_host", "severity": "info", "ip": ip,
            "mac": h.get("mac", ""), "vendor": h.get("vendor", ""), "hostname": h.get("hostname", ""),
            "message": f"Device {ip} from baseline is no longer responding",
        })

    # Hosts present in both: MAC changes + service-surface changes.
    for ip in sorted(b_ips & c_ips):
        bh, ch = b_hosts[ip], c_hosts[ip]
        b_mac = (bh.get("mac") or "").lower()
        c_mac = (ch.get("mac") or "").lower()
        if b_mac and c_mac and b_mac != c_mac:
            alerts.append({
                "type": "mac_changed", "severity": "critical", "ip": ip,
                "mac": c_mac, "old_mac": b_mac, "hostname": ch.get("hostname", ""),
                "message": f"MAC for {ip} changed {b_mac} → {c_mac} (possible ARP spoofing / device swap)",
            })
        if not service_capable:
            continue
        b_svc = {(s["port"], s.get("proto", "tcp")): s for s in bh.get("services", [])}
        c_svc = {(s["port"], s.get("proto", "tcp")): s for s in ch.get("services", [])}
        for key in sorted(c_svc.keys() - b_svc.keys()):
            s = c_svc[key]
            name = s.get("service") or "?"
            alerts.append({
                "type": "new_service", "severity": "warning", "ip": ip,
                "port": s["port"], "proto": s.get("proto", "tcp"), "service": s.get("service", ""),
                "message": f"New open service {s['port']}/{s.get('proto', 'tcp')} ({name}) on {ip}",
            })
        for key in sorted(b_svc.keys() - c_svc.keys()):
            s = b_svc[key]
            name = s.get("service") or "?"
            alerts.append({
                "type": "gone_service", "severity": "info", "ip": ip,
                "port": s["port"], "proto": s.get("proto", "tcp"), "service": s.get("service", ""),
                "message": f"Service {s['port']}/{s.get('proto', 'tcp')} ({name}) on {ip} no longer open",
            })
    return alerts


def _alert_summary(alerts: list[dict[str, Any]]) -> dict[str, int]:
    out = {"new_host": 0, "gone_host": 0, "new_service": 0, "gone_service": 0, "mac_changed": 0}
    for a in alerts:
        t = a.get("type", "")
        if t in out:
            out[t] += 1
    out["total"] = len(alerts)
    return out


async def _scan_for_snapshot(subnet: str, profile: str | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run the snapshot scan: ARP sweep (profile None) or a port-aware profile."""
    if profile:
        argv = PROFILES[profile] + [subnet]
        timeout = 3600.0
    else:
        argv = ["-sn", "-PR", subnet]
        timeout = 120.0
    xml_text = await _run_nmap(argv, timeout=timeout)
    hosts, summary = _parse_nmap_xml(xml_text)
    return hosts, summary


def _record_defense_scan(target: str, profile: str, summary: dict[str, Any]) -> None:
    """Persist a Scan-history row for a baseline/diff sweep (audit visibility)."""
    with session_scope() as s:
        s.add(Scan(
            target=target, profile=profile, status="success",
            started_at=datetime.utcnow(), finished_at=datetime.utcnow(),
            hosts_found=summary.get("up", 0), summary=summary, raw_xml="",
            engagement_id=engagement.engagement_id,
        ))


async def _publish_alerts(alerts: list[dict[str, Any]]) -> None:
    """Best-effort: fan noteworthy findings into the system-wide alert bus."""
    for a in alerts:
        if a.get("severity") not in ("warning", "critical"):
            continue
        try:
            await events.bus.publish(
                events.ALERT_FIRED,
                {"severity": a["severity"], "source": "net_recon", "message": a["message"]},
            )
        except Exception:  # noqa: BLE001
            pass


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

        # ------------------------------------------------------------------ #
        # Blue-team defensive monitoring
        # ------------------------------------------------------------------ #
        @r.post("/baseline")
        async def set_baseline(body: DefenseBody | None = None) -> dict[str, Any]:
            """Snapshot current hosts/services on the local subnet as the baseline."""
            profile = body.profile if body else None
            if profile is not None and profile not in PROFILES:
                raise HTTPException(400, f"unknown profile {profile!r}; choose one of {list(PROFILES)} or omit for host-discovery")
            subnet, _gw = _primary_iface_subnet()
            if not subnet:
                raise HTTPException(503, "could not determine local subnet")
            hosts, summary = await _scan_for_snapshot(subnet, profile)
            _upsert_hosts(hosts)
            snap = _build_snapshot(hosts, subnet=subnet, profile=profile)
            _save_json(_baseline_path(), snap)
            _record_defense_scan(subnet, "baseline", summary)
            return {"ok": True, "baseline": _baseline_meta(snap)}

        @r.get("/baseline")
        def get_baseline() -> dict[str, Any]:
            snap = _load_json(_baseline_path())
            if not snap:
                return {"ok": True, "baseline": None, "hosts": []}
            return {
                "ok": True,
                "baseline": _baseline_meta(snap),
                "hosts": list((snap.get("hosts") or {}).values()),
            }

        @r.post("/diff")
        async def run_diff(body: DefenseBody | None = None) -> dict[str, Any]:
            """Scan the local subnet and diff vs the saved baseline → alerts."""
            baseline = _load_json(_baseline_path())
            if not baseline:
                raise HTTPException(409, "no baseline set — POST /api/net_recon/baseline first")
            profile = body.profile if body else None
            if profile is not None and profile not in PROFILES:
                raise HTTPException(400, f"unknown profile {profile!r}; choose one of {list(PROFILES)} or omit for host-discovery")
            subnet, _gw = _primary_iface_subnet()
            if not subnet:
                raise HTTPException(503, "could not determine local subnet")
            hosts, summary = await _scan_for_snapshot(subnet, profile)
            _upsert_hosts(hosts)
            current = _build_snapshot(hosts, subnet=subnet, profile=profile)
            alerts = _diff_snapshots(baseline, current)
            result = {
                "generated_at": datetime.utcnow().isoformat(),
                "baseline_at": baseline.get("created_at"),
                "subnet": subnet,
                "profile": current["profile"],
                "host_count": current["host_count"],
                "summary": _alert_summary(alerts),
                "alerts": alerts,
            }
            _save_json(_alerts_path(), result)
            _record_defense_scan(subnet, "diff", summary)
            await _publish_alerts(alerts)
            return {"ok": True, **result}

        @r.get("/alerts")
        def get_alerts() -> dict[str, Any]:
            result = _load_json(_alerts_path())
            if not result:
                return {"ok": True, "alerts": [], "summary": _alert_summary([]), "generated_at": None}
            return {"ok": True, **result}

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.net_recon import NetReconScreen
        return NetReconScreen()
