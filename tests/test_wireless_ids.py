"""Unit tests for the wireless_ids blue-team module.

Covers the testable core:
  * pure detection classifiers (rogue AP / evil-twin / deauth-flood) against
    canned kismet device + alert JSON;
  * allowlist persistence round-trip (dedup + bssid normalization);
  * HTTP endpoints (status / detections / allowlist / start / stop) via a
    standalone app mounting ONLY this module's router — so the suite never
    depends on the full registry (server_audit.py lands separately).

No real kismet / helper subprocess is ever spawned — REST fetches and process
spawning are mocked.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-wids-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

import subprocess  # noqa: E402
import sys  # noqa: E402
from unittest.mock import AsyncMock, Mock  # noqa: E402

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import warlock.modules.wireless_ids as wi  # noqa: E402


@pytest.fixture()
def client() -> TestClient:
    """Standalone app with only the wireless_ids router (no auth, no registry)."""
    app = FastAPI()
    app.include_router(wi.Module().router())
    return TestClient(app)


# Canned kismet devices (field-simplified alias keys).
_DEVS = [
    {"mac": "AA:BB:CC:00:00:01", "type": "Wi-Fi AP", "ssid": "CorpNet",
     "channel": 6, "signal": -42, "first_time": 1700000000, "last_time": 1700000100},
    {"mac": "DE:AD:BE:EF:00:99", "type": "Wi-Fi AP", "ssid": "CorpNet",
     "channel": 11, "signal": -55, "first_time": 1700000050, "last_time": 1700000200},
    {"mac": "11:22:33:44:55:66", "type": "Wi-Fi AP", "ssid": "FreeWiFi",
     "channel": 1, "signal": -70},
    # a client device should be ignored by the AP classifier
    {"mac": "99:99:99:99:99:99", "type": "Wi-Fi Client", "ssid": ""},
    # hidden AP (no ssid) — not classifiable against an SSID allowlist
    {"mac": "77:77:77:77:77:77", "type": "Wi-Fi AP", "ssid": ""},
]


# --------------------------------------------------------------------------- #
# pure helpers
# --------------------------------------------------------------------------- #
def test_ts_iso_and_to_int():
    assert wi._ts_iso(0) is None
    assert wi._ts_iso(None) is None
    assert wi._ts_iso("not-a-number") is None
    assert wi._ts_iso(1700000000).startswith("2023-")
    assert wi._to_int("6") == 6
    assert wi._to_int(None) is None
    assert wi._to_int("x") is None


def test_extract_ap_handles_full_dotted_keys():
    dev = {
        "kismet.device.base.macaddr": "AA:BB:CC:DD:EE:FF",
        "kismet.device.base.type": "Wi-Fi AP",
        "kismet.device.base.channel": 36,
        "kismet.common.signal.last_signal": -60,
        "kismet.device.base.first_time": 1700000000,
        "kismet.device.base.last_time": 1700000300,
        "kismet.device.base.commonname": "LabAP",
    }
    assert wi._is_ap(dev)
    ap = wi._extract_ap(dev)
    assert ap["bssid"] == "aa:bb:cc:dd:ee:ff"
    assert ap["ssid"] == "LabAP"
    assert ap["channel"] == 36
    assert ap["signal"] == -60
    assert ap["last_seen"].startswith("2023-")


# --------------------------------------------------------------------------- #
# device classification
# --------------------------------------------------------------------------- #
def test_classify_empty_allowlist_flags_nothing():
    assert wi.classify_devices(_DEVS, [], []) == []


def test_classify_rogue_ap_for_unlisted_ssid():
    dets = wi.classify_devices(_DEVS, ["CorpNet"], ["aa:bb:cc:00:00:01"])
    rogue = [d for d in dets if d["type"] == "rogue_ap"]
    assert len(rogue) == 1
    assert rogue[0]["ssid"] == "FreeWiFi"
    assert rogue[0]["severity"] == "medium"
    assert rogue[0]["source"] == "analysis"


def test_classify_evil_twin_with_bssid_baseline():
    # CorpNet allowlisted; aa:bb..01 is trusted, de:ad..99 is the impostor.
    dets = wi.classify_devices(_DEVS, ["CorpNet"], ["aa:bb:cc:00:00:01"])
    twins = [d for d in dets if d["type"] == "evil_twin"]
    assert len(twins) == 1
    assert twins[0]["bssid"] == "de:ad:be:ef:00:99"
    assert twins[0]["severity"] == "high"


def test_classify_evil_twin_no_baseline_duplicate_bssids():
    # No BSSID baseline: both CorpNet radios are flagged (duplicate heuristic).
    dets = wi.classify_devices(_DEVS, ["CorpNet"], [])
    twins = {d["bssid"] for d in dets if d["type"] == "evil_twin"}
    assert twins == {"aa:bb:cc:00:00:01", "de:ad:be:ef:00:99"}


def test_classify_single_trusted_ssid_not_flagged():
    devs = [_DEVS[0]]  # one CorpNet AP only
    dets = wi.classify_devices(devs, ["CorpNet"], [])
    assert dets == []  # single BSSID for a trusted SSID -> legit, no flag


def test_classify_trusted_bssid_skipped_entirely():
    dets = wi.classify_devices(_DEVS, ["FreeWiFi"], ["11:22:33:44:55:66"])
    # FreeWiFi's only AP is on the trusted-BSSID list -> not rogue; CorpNet not on
    # SSID allowlist -> rogue x2.
    assert all(d["bssid"] != "11:22:33:44:55:66" for d in dets)
    assert {d["type"] for d in dets} == {"rogue_ap"}


# --------------------------------------------------------------------------- #
# alert classification
# --------------------------------------------------------------------------- #
def test_classify_alerts_deauth_flood_vs_generic():
    alerts = [
        {"kismet.alert.header": "DEAUTHFLOOD", "kismet.alert.text": "deauth flood",
         "kismet.alert.timestamp": 1700000123.5,
         "kismet.alert.transmitter_mac": "AA:BB:CC:00:00:01", "kismet.alert.channel": 6},
        {"kismet.alert.header": "BCASTDISCON", "kismet.alert.text": "broadcast disassoc"},
        {"kismet.alert.header": "APSPOOF", "kismet.alert.text": "spoofed ap"},
    ]
    dets = wi.classify_alerts(alerts)
    floods = [d for d in dets if d["type"] == "deauth_flood"]
    assert len(floods) == 2  # DEAUTHFLOOD + BCASTDISCON
    assert all(d["severity"] == "high" for d in floods)
    assert floods[0]["bssid"] == "aa:bb:cc:00:00:01"
    assert floods[0]["last_seen"].startswith("2023-")
    generic = [d for d in dets if d["type"] == "kismet_alert"]
    assert len(generic) == 1 and generic[0]["severity"] == "low"


def test_fetch_alerts_unwraps_both_shapes(monkeypatch):
    # _fetch_alerts must handle both {kismet.alert.list: [...]} and bare-list shapes.
    monkeypatch.setattr(
        wi, "_kismet_get_json",
        lambda path: {"kismet.alert.list": [{"kismet.alert.header": "DEAUTHFLOOD"}]},
    )
    assert wi._fetch_alerts() == [{"kismet.alert.header": "DEAUTHFLOOD"}]
    monkeypatch.setattr(wi, "_kismet_get_json", lambda path: [{"kismet.alert.header": "X"}])
    assert wi._fetch_alerts() == [{"kismet.alert.header": "X"}]


def test_fetch_devices_filters_non_dicts(monkeypatch):
    monkeypatch.setattr(
        wi, "_kismet_post_json",
        lambda path, payload: [{"mac": "aa"}, "junk", None, {"mac": "bb"}],
    )
    assert wi._fetch_devices() == [{"mac": "aa"}, {"mac": "bb"}]


# --------------------------------------------------------------------------- #
# allowlist persistence
# --------------------------------------------------------------------------- #
def test_allowlist_roundtrip_dedup_and_normalize(tmp_path, monkeypatch):
    monkeypatch.setattr(wi, "_allowlist_path", lambda: tmp_path / "allowlist.json")
    data = wi._write_allowlist(
        ["CorpNet", "corpnet", " GuestWiFi ", ""],
        ["AA:BB:CC:00:00:01", "aa:bb:cc:00:00:01", "  "],
    )
    assert data["ssids"] == ["CorpNet", "GuestWiFi"]   # case-insensitive dedup, trim
    assert data["bssids"] == ["aa:bb:cc:00:00:01"]      # lowercased + deduped
    again = wi._read_allowlist()
    assert again == data


def test_read_allowlist_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(wi, "_allowlist_path", lambda: tmp_path / "nope.json")
    assert wi._read_allowlist() == {"ssids": [], "bssids": []}


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #
def test_status_endpoint_idle(client, monkeypatch):
    monkeypatch.setattr(wi, "_is_running", lambda: False)
    r = client.get("/api/wireless_ids/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["running"] is False
    assert body["kismet_reachable"] is False
    assert "allowlist" in body


def test_detections_endpoint(client, monkeypatch):
    monkeypatch.setattr(wi, "_is_running", lambda: True)
    monkeypatch.setattr(wi, "_read_allowlist", lambda: {"ssids": ["CorpNet"], "bssids": ["aa:bb:cc:00:00:01"]})
    monkeypatch.setattr(wi, "_fetch_devices", lambda: _DEVS)
    monkeypatch.setattr(wi, "_fetch_alerts", lambda: [
        {"kismet.alert.header": "DEAUTHFLOOD", "kismet.alert.text": "flood",
         "kismet.alert.transmitter_mac": "DE:AD:BE:EF:00:99"},
    ])
    r = client.get("/api/wireless_ids/detections")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["counts"]["evil_twin"] == 1
    assert body["counts"]["rogue_ap"] == 1
    assert body["counts"]["deauth_flood"] == 1
    # highest severity sorts first
    assert body["detections"][0]["severity"] == "high"


def test_detections_endpoint_kismet_unreachable(client, monkeypatch):
    monkeypatch.setattr(wi, "_is_running", lambda: True)
    monkeypatch.setattr(wi, "_read_allowlist", lambda: {"ssids": ["CorpNet"], "bssids": []})

    def boom():
        raise RuntimeError("connection refused")

    monkeypatch.setattr(wi, "_fetch_devices", boom)
    monkeypatch.setattr(wi, "_fetch_alerts", boom)
    r = client.get("/api/wireless_ids/detections")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert len(body["errors"]) == 2
    assert body["detections"] == []


def test_allowlist_endpoints_roundtrip(client, tmp_path, monkeypatch):
    monkeypatch.setattr(wi, "_allowlist_path", lambda: tmp_path / "allowlist.json")
    post = client.post(
        "/api/wireless_ids/allowlist",
        json={"ssids": ["CorpNet", "corpnet"], "bssids": ["AA:BB:CC:00:00:01"]},
    )
    assert post.status_code == 200
    assert post.json()["ssids"] == ["CorpNet"]
    get = client.get("/api/wireless_ids/allowlist")
    assert get.json()["bssids"] == ["aa:bb:cc:00:00:01"]


def test_start_endpoint_launches_kismet(client, tmp_path, monkeypatch):
    net = tmp_path / "net"
    mon = net / "mon0"
    mon.mkdir(parents=True)
    (mon / "flags").write_text("0x1003\n")  # up
    monkeypatch.setattr(wi, "_SYS_CLASS_NET", net)
    monkeypatch.setattr(wi, "KISMET", sys.executable)  # passes the exists() check
    monkeypatch.setattr(wi, "_is_running", lambda: False)
    monkeypatch.setattr(wi, "PID_PATH", tmp_path / "kismet.pid")
    monkeypatch.setattr(wi, "STATE_PATH", tmp_path / "kismet.state")
    monkeypatch.setattr(wi, "_run_helper", AsyncMock(return_value="ok"))

    fake_proc = Mock()
    fake_proc.pid = 5150
    monkeypatch.setattr(subprocess, "Popen", Mock(return_value=fake_proc))

    r = client.post("/api/wireless_ids/start", json={"channels": "1,6,11"})
    assert r.status_code == 200
    assert r.json()["state"]["pid"] == 5150


def test_start_refuses_when_iface_not_ready(client, tmp_path, monkeypatch):
    net = tmp_path / "net"
    net.mkdir()  # mon0 absent -> not ready
    monkeypatch.setattr(wi, "_SYS_CLASS_NET", net)
    monkeypatch.setattr(wi, "KISMET", sys.executable)
    monkeypatch.setattr(wi, "_is_running", lambda: False)
    monkeypatch.setattr(wi, "_run_helper", AsyncMock(return_value="ok"))
    popen = Mock(side_effect=AssertionError("kismet must NOT be spawned"))
    monkeypatch.setattr(subprocess, "Popen", popen)

    r = client.post("/api/wireless_ids/start", json={})
    assert r.status_code == 500
    assert "refusing to launch" in r.json()["detail"]
    popen.assert_not_called()


def test_stop_endpoint(client, tmp_path, monkeypatch):
    monkeypatch.setattr(wi, "PID_PATH", tmp_path / "kismet.pid")
    monkeypatch.setattr(wi, "STATE_PATH", tmp_path / "kismet.state")
    (tmp_path / "kismet.state").write_text('{"pid": 999999}')  # non-existent pid
    monkeypatch.setattr(wi, "_run_helper", AsyncMock(return_value="managed"))
    r = client.post("/api/wireless_ids/stop")
    assert r.status_code == 200
    assert r.json()["ok"] is True
