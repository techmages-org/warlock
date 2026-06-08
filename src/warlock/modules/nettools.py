"""Field Utility Pack — the small blades (Track A / A11).

Quick everyday tech utilities:

  POST /api/nettools/subnet     — CIDR calculator (network/broadcast/mask/range/host count)
  POST /api/nettools/oui        — MAC -> vendor (offline OUI database)
  POST /api/nettools/wol        — Wake-on-LAN magic packet to a MAC
  POST /api/nettools/tls        — TLS/cert inspector (issuer, SAN, expiry, days left, weak proto)
  POST /api/nettools/speedtest  — internet download throughput (Mbps)
  GET  /api/nettools/status     — tool availability

Pure-Python where possible (ipaddress/socket/ssl); speedtest uses curl. The
"leave-it-running" continuous monitor is covered by net_recon's baseline-diff
alerting (extend there). Active utilities (tls/speedtest/wol) are audited.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import logging
import os
import shutil
import socket
import ssl
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import AuditEntry
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.nettools")
_OUI: dict[str, str] | None = None


def _tool(name: str) -> str | None:
    p = shutil.which(name)
    if p:
        return p
    for d in ("/usr/sbin", "/sbin", "/usr/bin", "/bin"):
        c = os.path.join(d, name)
        if os.path.exists(c):
            return c
    return None


def _audit(kind: str, command: str, target: str, note: str, outcome: str) -> None:
    try:
        with session_scope() as s:
            s.add(AuditEntry(engagement_id=engagement.engagement_id, kind=kind, command=command,
                             sha256=hashlib.sha256(command.encode()).hexdigest(), target=target,
                             note=note, outcome=outcome))
    except Exception:  # noqa: BLE001
        log.warning("nettools audit failed (non-fatal)", exc_info=True)


def _oui_db() -> dict[str, str]:
    global _OUI
    if _OUI is not None:
        return _OUI
    _OUI = {}
    for path in ("/usr/share/nmap/nmap-mac-prefixes", "/usr/share/ieee-data/oui.txt"):
        if os.path.exists(path):
            try:
                for line in open(path, encoding="utf-8", errors="replace"):
                    line = line.strip()
                    if len(line) >= 7 and line[:6].isalnum() and line[6] == " ":
                        _OUI[line[:6].upper()] = line[7:].strip()
            except OSError:
                pass
            if _OUI:
                break
    return _OUI


def _mac_bytes(mac: str) -> bytes:
    h = mac.replace(":", "").replace("-", "").replace(".", "").strip()
    if len(h) != 12 or not all(c in "0123456789abcdefABCDEF" for c in h):
        raise HTTPException(400, f"bad MAC: {mac!r}")
    return bytes.fromhex(h)


def _tls_inspect(host: str, port: int) -> dict[str, Any]:
    import datetime as _dt

    from cryptography import x509

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # inspect ANY cert (expired/self-signed); parse DER ourselves
    with socket.create_connection((host, port), timeout=8) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ss:
            der = ss.getpeercert(binary_form=True)
            proto, cipher = ss.version(), ss.cipher()
    cert = x509.load_der_x509_certificate(der)
    not_after_dt = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after
    if not_after_dt.tzinfo is None:
        not_after_dt = not_after_dt.replace(tzinfo=_dt.timezone.utc)
    days_left = round((not_after_dt - _dt.datetime.now(_dt.timezone.utc)).total_seconds() / 86400, 1)

    def _cn(name: Any) -> str | None:
        try:
            return name.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
        except Exception:  # noqa: BLE001
            return None

    sans: list[str] = []
    try:
        sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    except Exception:  # noqa: BLE001
        pass
    weak = proto in ("TLSv1", "TLSv1.1", "SSLv3")
    return {"host": host, "port": port, "protocol": proto, "cipher": cipher[0] if cipher else None,
            "subject_cn": _cn(cert.subject), "issuer_cn": _cn(cert.issuer), "san": sans[:12],
            "not_after": not_after_dt.strftime("%Y-%m-%d %H:%M:%SZ"), "days_left": days_left,
            "verdict": "FAIL" if (days_left < 0 or weak) else ("WARN" if days_left < 21 else "PASS"),
            "note": ("CERT EXPIRED" if days_left < 0 else (f"weak protocol {proto}" if weak
                     else f"valid, expires in {days_left}d"))}


class SubnetReq(BaseModel):
    cidr: str


class OuiReq(BaseModel):
    mac: str


class WolReq(BaseModel):
    mac: str
    broadcast: str = "255.255.255.255"
    port: int = 9


class TlsReq(BaseModel):
    host: str
    port: int = Field(default=443, ge=1, le=65535)


class SpeedReq(BaseModel):
    url: str = "https://speed.cloudflare.com/__down?bytes=25000000"
    max_secs: int = Field(default=15, ge=3, le=60)


class Module(ModuleBase):
    id = "nettools"
    label = "Net Tools"
    icon = "✛"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status_ep() -> dict[str, Any]:
            return {"ok": True, "oui_entries": len(_oui_db()), "curl": bool(_tool("curl")),
                    "checks": ["subnet", "oui", "wol", "tls", "speedtest"]}

        @r.post("/subnet")
        def subnet_ep(req: SubnetReq) -> dict[str, Any]:
            try:
                net = ipaddress.ip_network(req.cidr, strict=False)
            except ValueError as e:
                raise HTTPException(400, f"bad CIDR: {e}") from None
            hosts = list(net.hosts())
            return {"ok": True, "network": str(net.network_address), "prefix": net.prefixlen,
                    "netmask": str(net.netmask), "broadcast": str(getattr(net, "broadcast_address", "")),
                    "total_addresses": net.num_addresses, "usable_hosts": len(hosts),
                    "first_host": str(hosts[0]) if hosts else None,
                    "last_host": str(hosts[-1]) if hosts else None, "version": net.version}

        @r.post("/oui")
        def oui_ep(req: OuiReq) -> dict[str, Any]:
            b = _mac_bytes(req.mac)
            prefix = b.hex().upper()[:6]
            vendor = _oui_db().get(prefix)
            return {"ok": True, "mac": req.mac, "oui": prefix, "vendor": vendor or "unknown",
                    "locally_administered": bool(b[0] & 0x02), "multicast": bool(b[0] & 0x01)}

        @r.post("/wol")
        def wol_ep(req: WolReq) -> dict[str, Any]:
            mb = _mac_bytes(req.mac)
            packet = b"\xff" * 6 + mb * 16
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            s.sendto(packet, (req.broadcast, req.port))
            s.close()
            _audit("nettools.wol", f"wol {req.mac} -> {req.broadcast}:{req.port}", req.mac, "magic packet sent", "success")
            return {"ok": True, "mac": req.mac, "sent_to": f"{req.broadcast}:{req.port}", "bytes": len(packet)}

        @r.post("/tls")
        async def tls_ep(req: TlsReq) -> dict[str, Any]:
            try:
                res = await asyncio.to_thread(_tls_inspect, req.host, req.port)
            except (OSError, ssl.SSLError, socket.timeout) as e:
                _audit("nettools.tls", f"tls {req.host}:{req.port}", req.host, str(e)[:120], "error")
                raise HTTPException(502, f"TLS connect failed: {e}") from None
            _audit("nettools.tls", f"tls {req.host}:{req.port}", req.host, res["note"], "success")
            return {"ok": True, **res}

        @r.post("/speedtest")
        async def speedtest_ep(req: SpeedReq) -> dict[str, Any]:
            if not _tool("curl"):
                raise HTTPException(503, "curl not installed")
            argv = [_tool("curl"), "-s", "-o", "/dev/null", "-w", "%{speed_download} %{size_download} %{time_total}",
                    "--max-time", str(req.max_secs), req.url]
            try:
                proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                            stderr=asyncio.subprocess.PIPE)
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=req.max_secs + 5)
            except asyncio.TimeoutError:
                raise HTTPException(504, "speedtest timed out") from None
            parts = out.decode().split()
            bps = float(parts[0]) if parts else 0.0
            mbps = round(bps * 8 / 1e6, 2)
            _audit("nettools.speedtest", f"speedtest {req.url}", req.url, f"{mbps} Mbps", "success")
            return {"ok": True, "download_mbps": mbps, "bytes": int(float(parts[1])) if len(parts) > 1 else None,
                    "seconds": float(parts[2]) if len(parts) > 2 else None, "url": req.url}

        return r
