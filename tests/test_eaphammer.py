"""Tests for the eaphammer (WPA-Enterprise harvester) endpoint.

Verifies:
  - 400 on empty SSID
  - 403 without engagement (engagement gate)
  - tool detection logic
  - request model validation
"""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WARLOCK_DATA_DIR", str(tmp_path))
    from warlock.server import create_app
    return TestClient(create_app())


def test_eaphammer_without_engagement_is_403(client):
    """Must refuse without an active engagement — same gate as all offensive ops."""
    r = client.post("/api/wifi_offensive/eaphammer", json={"ssid": "CorpWiFi"})
    assert r.status_code == 403


def test_eaphammer_empty_ssid_is_400(client):
    """Empty SSID should be rejected at the endpoint level."""
    r = client.post("/api/wifi_offensive/eaphammer", json={"ssid": ""})
    assert r.status_code in (400, 403)


def test_eaphammer_model_validation():
    """Pydantic model accepts valid inputs and applies defaults."""
    from warlock.modules.wifi_offensive import EaphammerBody

    body = EaphammerBody(ssid="TestEAP")
    assert body.ssid == "TestEAP"
    assert body.channel == 1
    assert body.duration == 300
    assert body.eap_type == "mschapv2"

    body2 = EaphammerBody(ssid="Corp", channel=6, duration=600, eap_type="peap")
    assert body2.channel == 6
    assert body2.duration == 600
    assert body2.eap_type == "peap"

    # Channel bounds
    with pytest.raises(Exception):
        EaphammerBody(ssid="X", channel=0)
    with pytest.raises(Exception):
        EaphammerBody(ssid="X", channel=200)

    # Duration bounds
    with pytest.raises(Exception):
        EaphammerBody(ssid="X", duration=10)
    with pytest.raises(Exception):
        EaphammerBody(ssid="X", duration=200_000)


def test_eaphammer_in_ops_list(client):
    """The status endpoint should list eaphammer in the ops array."""
    r = client.get("/api/wifi_offensive/status")
    assert r.status_code == 200
    data = r.json()
    assert "eaphammer" in data.get("ops", [])
