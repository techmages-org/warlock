"""Tests for the Capture module — tshark availability, capture ID validation,
and endpoint structure."""
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


# --------------------------------------------------------------------------- #
# /api/capture/status
# --------------------------------------------------------------------------- #
def test_status_returns_tool_availability(client):
    r = client.get("/api/capture/status")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "tshark" in data
    assert "dumpcap" in data
    assert "captures" in data
    assert isinstance(data["captures"], int)


# --------------------------------------------------------------------------- #
# Capture ID validation — path traversal protection
# --------------------------------------------------------------------------- #
def test_download_rejects_bad_id(client):
    """Capture IDs must match cap-<timestamp>-<hex> — prevents path traversal."""
    r = client.get("/api/capture/download/cap-evil-hack")
    assert r.status_code == 400


def test_download_rejects_malformed_id(client):
    r = client.get("/api/capture/download/not-a-real-id")
    assert r.status_code == 400


def test_analyze_rejects_bad_id(client):
    r = client.post("/api/capture/analyze", json={"id": "cap-evil-hack"})
    assert r.status_code == 400


def test_analyze_rejects_malformed_id(client):
    r = client.post("/api/capture/analyze", json={"id": "garbage"})
    assert r.status_code == 400


def test_download_404_for_valid_format_but_missing(client):
    """Valid format ID but no file -> 404, not 400."""
    r = client.get("/api/capture/download/cap-1234567890-deadbe")
    assert r.status_code == 404


def test_analyze_404_for_valid_format_but_missing(client):
    r = client.post("/api/capture/analyze", json={"id": "cap-1234567890-deadbe"})
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# /api/capture/list
# --------------------------------------------------------------------------- #
def test_list_returns_captures(client):
    r = client.get("/api/capture/list")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "captures" in data
    assert isinstance(data["captures"], list)
    assert data["count"] == len(data["captures"])


# --------------------------------------------------------------------------- #
# Capture request model validation
# --------------------------------------------------------------------------- #
def test_capture_req_model_defaults():
    from warlock.modules.capture import CaptureReq
    req = CaptureReq()
    assert req.iface is None
    assert req.filter is None
    assert req.seconds == 10
    assert req.max_packets == 20000


def test_capture_req_model_bounds():
    from warlock.modules.capture import CaptureReq
    # seconds: 1-120
    with pytest.raises(Exception):
        CaptureReq(seconds=0)
    with pytest.raises(Exception):
        CaptureReq(seconds=121)
    # max_packets: 1-500000
    with pytest.raises(Exception):
        CaptureReq(max_packets=0)
    with pytest.raises(Exception):
        CaptureReq(max_packets=600000)
