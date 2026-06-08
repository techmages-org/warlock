"""One-button Site-Survey / Network-Health Report (Track A / A4).

  POST /api/report/generate     — run the core diagnostics and produce a structured report
  GET  /api/report/download/{id}— the rendered HTML (print-to-PDF in the browser)
  GET  /api/report/list         — recent reports

Aggregates the netdiag + wifi_analyzer checks into one verdict + a client-ready HTML page. The
JSON core is structured so the AAR report generator (Track B) can sign it into an attestation.
"""
from __future__ import annotations

import json
import logging
import re
import socket
import time
from html import escape
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from warlock.config import get_settings
from warlock.modules import netdiag as nd
from warlock.modules import wifi_analyzer as wa
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.report")
_ORDER = {"FAIL": 2, "WARN": 1, "PASS": 0, "INFO": 0, "unknown": 0}


def _reports_dir() -> Path:
    d = get_settings().data / "reports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _worst(verdicts: list[str]) -> str:
    out = "PASS"
    for v in verdicts:
        if _ORDER.get(v, 0) > _ORDER.get(out, 0):
            out = v
    return out


async def _gather(iface: str | None) -> dict[str, Any]:
    dr = await nd._default_route()
    eth = iface or dr.get("iface") or "eth0"
    sections: dict[str, Any] = {}

    link = await nd._link(eth)
    errors = await nd._ethtool_errors(eth)
    flap = nd._flap_counters(eth)
    carrier = bool(link.get("carrier") or link.get("wifi") or (link.get("wired") or {}).get("link_detected"))
    sections["link"] = {"verdict": "PASS" if carrier else "FAIL", "iface": eth, "data": link,
                        "errors": errors.get("nonzero"), "flaps": flap.get("carrier_changes")}

    gw = await nd._gateway_ping(dr.get("gateway"))
    dns = await nd._dns()
    pmtu = await nd._path_mtu()
    gw_v = "PASS" if gw.get("loss_pct") == 0 else ("FAIL" if (gw.get("loss_pct") or 100) >= 100 else "WARN")
    dns_v = "PASS" if dns.get("resolved") else "FAIL"
    sections["reachability"] = {"verdict": _worst([gw_v, dns_v]), "gateway": gw, "dns": dns, "path_mtu": pmtu}

    wan = await nd._wan_check()
    ntp = await nd._ntp_check()
    try:
        dhcp = await nd._dhcp_scan(eth)
    except Exception:  # noqa: BLE001
        dhcp = {"verdict": "unknown", "note": "dhcp scan skipped"}
    sections["services"] = {"verdict": _worst([wan.get("verdict", "unknown"), ntp.get("verdict", "unknown"),
                                               dhcp.get("verdict", "unknown")]),
                            "wan": wan, "ntp": ntp, "dhcp": dhcp}

    try:
        wifi_iface = await wa._wifi_iface(None)
        aps = await wa._scan(wifi_iface)
        cur = await wa._link(wifi_iface)
        by_band: dict[str, int] = {}
        for a in aps:
            if a.get("band"):
                by_band[a["band"]] = by_band.get(a["band"], 0) + 1
        sections["wireless"] = {"verdict": "INFO", "iface": wifi_iface, "ap_count": len(aps),
                                "by_band": by_band, "current": cur}
    except Exception:  # noqa: BLE001
        sections["wireless"] = {"verdict": "unknown", "note": "no wifi scan"}

    overall = _worst([s.get("verdict", "unknown") for s in sections.values()])
    s = get_settings()
    return {"report": "network-health", "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "deck": {"hostname": socket.gethostname(), "subject_did": getattr(s, "aar_subject_did", None)},
            "summary": {"overall": overall}, "sections": sections}


_COLOR = {"PASS": "#5AF78E", "WARN": "#F0A830", "FAIL": "#E0556B", "INFO": "#9B8CF0", "unknown": "#888"}


def _html(rep: dict[str, Any]) -> str:
    ov = rep["summary"]["overall"]
    rows = []
    for name, sec in rep["sections"].items():
        v = sec.get("verdict", "unknown")
        detail = escape(json.dumps({k: x for k, x in sec.items() if k != "verdict"}, default=str)[:600])
        rows.append(f'<tr><td>{escape(name)}</td><td style="color:{_COLOR.get(v)};font-weight:700">{v}</td>'
                    f'<td style="font-family:monospace;font-size:11px;color:#aaa">{detail}</td></tr>')
    deck = rep["deck"]
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Network Health — {escape(deck['hostname'])}</title>
<style>body{{font-family:Inter,system-ui,sans-serif;background:#0A0B10;color:#e8e9f2;max-width:900px;margin:2rem auto;padding:0 1rem}}
h1{{font-family:'JetBrains Mono',monospace}} .badge{{display:inline-block;padding:.4rem 1rem;border-radius:8px;font-weight:800;color:#0A0B10;background:{_COLOR.get(ov)}}}
table{{width:100%;border-collapse:collapse;margin-top:1rem}} td,th{{text-align:left;padding:.6rem;border-bottom:1px solid #2a2c38;vertical-align:top}}
.meta{{color:#9aa;font-size:.85rem}}</style></head><body>
<h1>Network Health Report</h1>
<p class="meta">Deck <b>{escape(deck['hostname'])}</b> · {escape(rep['generated'])} · {escape(str(deck.get('subject_did') or ''))}</p>
<p>Overall: <span class="badge">{ov}</span></p>
<table><tr><th>Section</th><th>Verdict</th><th>Detail</th></tr>{''.join(rows)}</table>
<p class="meta" style="margin-top:2rem">Warlock OS · netdiag/wifi_analyzer · print to PDF to save. Sign with AAR for an attestation.</p>
</body></html>"""


class GenReq(BaseModel):
    iface: str | None = None


class Module(ModuleBase):
    id = "report"
    label = "Report"
    icon = "▤"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.post("/generate")
        async def generate_ep(req: GenReq) -> dict[str, Any]:
            rep = await _gather(req.iface)
            rid = f"rpt-{int(time.time())}"
            (_reports_dir() / f"{rid}.json").write_text(json.dumps(rep, indent=2, default=str))
            (_reports_dir() / f"{rid}.html").write_text(_html(rep))
            return {"ok": True, "id": rid, "overall": rep["summary"]["overall"], "report": rep}

        @r.get("/list")
        def list_ep() -> dict[str, Any]:
            rs = [{"id": p.stem, "mtime": int(p.stat().st_mtime)}
                  for p in sorted(_reports_dir().glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:50]]
            return {"ok": True, "count": len(rs), "reports": rs}

        @r.get("/download/{rid}")
        def download_ep(rid: str) -> FileResponse:
            if not re.fullmatch(r"rpt-[0-9]+", rid):
                raise HTTPException(400, "bad report id")
            p = _reports_dir() / f"{rid}.html"
            if not p.exists():
                raise HTTPException(404, "report not found")
            return FileResponse(str(p), media_type="text/html", filename=f"{rid}.html")

        return r
