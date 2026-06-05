"""Unit tests for net_recon's blue-team defensive monitoring.

Covers the baseline snapshot + scan-diff alerting added on top of the existing
recon routes:

  * pure diff/snapshot logic — new host, gone host, new/gone service, MAC change,
    and the "skip service diffs when a scan had no port visibility" guard;
  * baseline save/load round-trip through the API;
  * the /diff endpoint flagging a new device + new service, persisted and served
    back by /alerts;
  * the existing /status route still answering (no regression).

No real nmap is ever spawned — ``_run_nmap`` is mocked and the baseline/alerts
files are redirected to a per-test ``tmp_path`` so nothing leaks across tests or
touches the operator data root.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-netrecon-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

from unittest.mock import AsyncMock  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import warlock.modules.net_recon as nr  # noqa: E402

SUBNET = "192.168.100.0/24"


@pytest.fixture(scope="module")
def client():
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


def _nmap_xml(hosts: list[dict]) -> str:
    """Build a minimal nmap -oX XML doc from a host spec list.

    host spec: {ip, mac?, vendor?, hostname?, ports?: [(portid, service_name)]}.
    """
    parts = ['<?xml version="1.0"?><nmaprun>']
    for h in hosts:
        parts.append('<host><status state="up"/>')
        parts.append(f'<address addr="{h["ip"]}" addrtype="ipv4"/>')
        if h.get("mac"):
            parts.append(f'<address addr="{h["mac"]}" addrtype="mac" vendor="{h.get("vendor", "")}"/>')
        if h.get("hostname"):
            parts.append(f'<hostnames><hostname name="{h["hostname"]}"/></hostnames>')
        ports = h.get("ports") or []
        if ports:
            parts.append("<ports>")
            for pid, name in ports:
                parts.append(
                    f'<port protocol="tcp" portid="{pid}"><state state="open"/>'
                    f'<service name="{name}"/></port>'
                )
            parts.append("</ports>")
        parts.append("</host>")
    parts.append("</nmaprun>")
    return "".join(parts)


def _snap(hosts, *, profile="quick"):
    """Build a snapshot the same way the routes do (via parse → build)."""
    parsed, _ = nr._parse_nmap_xml(_nmap_xml(hosts))
    return nr._build_snapshot(parsed, subnet=SUBNET, profile=profile)


# --------------------------------------------------------------------------- #
# Pure snapshot + diff logic (no client, no nmap)
# --------------------------------------------------------------------------- #
def test_build_snapshot_shape():
    snap = _snap([
        {"ip": "192.168.100.1", "ports": [(53, "domain")]},
        {"ip": "192.168.100.10", "mac": "AA:BB:CC:DD:EE:01", "vendor": "Dell", "ports": [(22, "ssh")]},
    ], profile="quick")

    assert snap["host_count"] == 2
    assert snap["service_count"] == 2
    assert snap["host_discovery_only"] is False
    assert set(snap["hosts"]) == {"192.168.100.1", "192.168.100.10"}
    # MAC is normalised lower-case so diffs are case-insensitive.
    assert snap["hosts"]["192.168.100.10"]["mac"] == "aa:bb:cc:dd:ee:01"
    svc = snap["hosts"]["192.168.100.10"]["services"][0]
    assert svc["port"] == 22 and svc["proto"] == "tcp" and svc["service"] == "ssh"


def test_diff_new_host():
    base = _snap([{"ip": "192.168.100.1", "ports": [(53, "domain")]}])
    cur = _snap([
        {"ip": "192.168.100.1", "ports": [(53, "domain")]},
        {"ip": "192.168.100.55", "mac": "aa:bb:cc:dd:ee:99", "vendor": "Raspberry Pi", "ports": []},
    ])
    alerts = nr._diff_snapshots(base, cur)
    new = [a for a in alerts if a["type"] == "new_host"]
    assert len(new) == 1
    assert new[0]["ip"] == "192.168.100.55"
    assert new[0]["severity"] == "warning"
    assert "Raspberry Pi" in new[0]["message"]


def test_diff_gone_host():
    base = _snap([
        {"ip": "192.168.100.1", "ports": [(53, "domain")]},
        {"ip": "192.168.100.10", "ports": [(22, "ssh")]},
    ])
    cur = _snap([{"ip": "192.168.100.1", "ports": [(53, "domain")]}])
    alerts = nr._diff_snapshots(base, cur)
    gone = [a for a in alerts if a["type"] == "gone_host"]
    assert len(gone) == 1
    assert gone[0]["ip"] == "192.168.100.10"
    assert gone[0]["severity"] == "info"


def test_diff_new_and_gone_service():
    base = _snap([{"ip": "192.168.100.10", "ports": [(22, "ssh")]}])
    cur = _snap([{"ip": "192.168.100.10", "ports": [(22, "ssh"), (80, "http")]}])
    alerts = nr._diff_snapshots(base, cur)
    new_svc = [a for a in alerts if a["type"] == "new_service"]
    assert len(new_svc) == 1
    assert new_svc[0]["port"] == 80 and new_svc[0]["service"] == "http"
    assert new_svc[0]["severity"] == "warning"

    # And the reverse direction yields a (low-severity) gone_service.
    rev = nr._diff_snapshots(cur, base)
    gone_svc = [a for a in rev if a["type"] == "gone_service"]
    assert len(gone_svc) == 1 and gone_svc[0]["port"] == 80


def test_diff_mac_changed_is_critical():
    base = _snap([{"ip": "192.168.100.10", "mac": "aa:bb:cc:dd:ee:01", "ports": [(22, "ssh")]}])
    cur = _snap([{"ip": "192.168.100.10", "mac": "aa:bb:cc:dd:ee:ff", "ports": [(22, "ssh")]}])
    alerts = nr._diff_snapshots(base, cur)
    mac = [a for a in alerts if a["type"] == "mac_changed"]
    assert len(mac) == 1
    assert mac[0]["severity"] == "critical"
    assert mac[0]["old_mac"] == "aa:bb:cc:dd:ee:01" and mac[0]["mac"] == "aa:bb:cc:dd:ee:ff"


def test_diff_skips_services_when_host_discovery_only():
    # Baseline was an ARP sweep (no port visibility) — absence of port data must
    # NOT be read as "all services gone", and a port-aware diff must not flood
    # new_service for ports the baseline simply never looked at.
    base = _snap([{"ip": "192.168.100.10", "ports": []}], profile=None)
    assert base["host_discovery_only"] is True
    cur = _snap([{"ip": "192.168.100.10", "ports": [(22, "ssh"), (80, "http")]}], profile="quick")
    alerts = nr._diff_snapshots(base, cur)
    assert [a for a in alerts if a["type"] in ("new_service", "gone_service")] == []


def test_alert_summary_counts():
    base = _snap([{"ip": "192.168.100.10", "ports": [(22, "ssh")]}])
    cur = _snap([
        {"ip": "192.168.100.10", "ports": [(22, "ssh"), (443, "https")]},
        {"ip": "192.168.100.77", "ports": []},
    ])
    summary = nr._alert_summary(nr._diff_snapshots(base, cur))
    assert summary["new_host"] == 1
    assert summary["new_service"] == 1
    assert summary["total"] == 2


# --------------------------------------------------------------------------- #
# API: baseline save/load + diff/alerts (nmap mocked, files redirected)
# --------------------------------------------------------------------------- #
def test_baseline_save_and_get(client, tmp_path, monkeypatch):
    bpath = tmp_path / "baseline.json"
    monkeypatch.setattr(nr, "_baseline_path", lambda: bpath)
    monkeypatch.setattr(nr, "_primary_iface_subnet", lambda: (SUBNET, "192.168.100.1"))
    monkeypatch.setattr(nr, "_run_nmap", AsyncMock(return_value=_nmap_xml([
        {"ip": "192.168.100.1", "ports": [(53, "domain")]},
        {"ip": "192.168.100.10", "mac": "aa:bb:cc:dd:ee:01", "ports": [(22, "ssh")]},
    ])))

    r = client.post("/api/net_recon/baseline", json={"profile": "quick"})
    assert r.status_code == 200, r.text
    meta = r.json()["baseline"]
    assert meta["host_count"] == 2 and meta["service_count"] == 2
    assert meta["profile"] == "quick" and meta["host_discovery_only"] is False
    assert bpath.exists()

    g = client.get("/api/net_recon/baseline")
    assert g.status_code == 200
    body = g.json()
    assert body["baseline"]["host_count"] == 2
    assert {h["ip"] for h in body["hosts"]} == {"192.168.100.1", "192.168.100.10"}


def test_get_baseline_none_when_unset(client, tmp_path, monkeypatch):
    monkeypatch.setattr(nr, "_baseline_path", lambda: tmp_path / "missing.json")
    r = client.get("/api/net_recon/baseline")
    assert r.status_code == 200
    assert r.json()["baseline"] is None


def test_diff_without_baseline_409(client, tmp_path, monkeypatch):
    monkeypatch.setattr(nr, "_baseline_path", lambda: tmp_path / "missing.json")
    monkeypatch.setattr(nr, "_primary_iface_subnet", lambda: (SUBNET, "192.168.100.1"))
    monkeypatch.setattr(nr, "_run_nmap", AsyncMock(return_value=_nmap_xml([])))
    r = client.post("/api/net_recon/diff", json={"profile": "quick"})
    assert r.status_code == 409


def test_diff_flags_new_host_and_service_then_alerts(client, tmp_path, monkeypatch):
    bpath = tmp_path / "baseline.json"
    apath = tmp_path / "alerts.json"
    monkeypatch.setattr(nr, "_baseline_path", lambda: bpath)
    monkeypatch.setattr(nr, "_alerts_path", lambda: apath)
    monkeypatch.setattr(nr, "_primary_iface_subnet", lambda: (SUBNET, "192.168.100.1"))

    baseline_xml = _nmap_xml([
        {"ip": "192.168.100.1", "ports": [(53, "domain")]},
        {"ip": "192.168.100.10", "mac": "aa:bb:cc:dd:ee:01", "ports": [(22, "ssh")]},
    ])
    diff_xml = _nmap_xml([
        {"ip": "192.168.100.1", "ports": [(53, "domain")]},
        {"ip": "192.168.100.10", "mac": "aa:bb:cc:dd:ee:01", "ports": [(22, "ssh"), (80, "http")]},
        {"ip": "192.168.100.55", "mac": "aa:bb:cc:dd:ee:99", "vendor": "Espressif", "ports": []},
    ])
    monkeypatch.setattr(nr, "_run_nmap", AsyncMock(side_effect=[baseline_xml, diff_xml]))

    assert client.post("/api/net_recon/baseline", json={"profile": "quick"}).status_code == 200

    d = client.post("/api/net_recon/diff", json={"profile": "quick"})
    assert d.status_code == 200, d.text
    body = d.json()
    types = {a["type"] for a in body["alerts"]}
    assert "new_host" in types and "new_service" in types
    assert body["summary"]["new_host"] == 1
    assert body["summary"]["new_service"] == 1
    new_host = next(a for a in body["alerts"] if a["type"] == "new_host")
    assert new_host["ip"] == "192.168.100.55"
    new_svc = next(a for a in body["alerts"] if a["type"] == "new_service")
    assert new_svc["ip"] == "192.168.100.10" and new_svc["port"] == 80

    # /alerts serves back the persisted diff result.
    a = client.get("/api/net_recon/alerts")
    assert a.status_code == 200
    abody = a.json()
    assert abody["summary"]["total"] == body["summary"]["total"]
    assert {al["type"] for al in abody["alerts"]} == types


def test_baseline_rejects_unknown_profile(client, tmp_path, monkeypatch):
    monkeypatch.setattr(nr, "_baseline_path", lambda: tmp_path / "baseline.json")
    monkeypatch.setattr(nr, "_primary_iface_subnet", lambda: (SUBNET, "192.168.100.1"))
    r = client.post("/api/net_recon/baseline", json={"profile": "bogus"})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Regression: existing recon routes still answer
# --------------------------------------------------------------------------- #
def test_existing_status_route_ok(client):
    r = client.get("/api/net_recon/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "profiles" in body and "hosts_seen" in body


def test_existing_alerts_empty_by_default(client, tmp_path, monkeypatch):
    monkeypatch.setattr(nr, "_alerts_path", lambda: tmp_path / "no-alerts.json")
    r = client.get("/api/net_recon/alerts")
    assert r.status_code == 200
    assert r.json()["alerts"] == []
