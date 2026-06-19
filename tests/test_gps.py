"""Tests for the GPS module — fix, satellites, time sync, and
helper functions."""
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
# Endpoints — these degrade gracefully when no GPS hardware is present
# --------------------------------------------------------------------------- #
def test_fix_returns_response(client):
    """Even without GPS hardware, /fix should return a dict, not crash."""
    r = client.get("/api/gps/fix")
    assert r.status_code == 200
    data = r.json()
    assert "ok" in data


def test_sats_returns_response(client):
    r = client.get("/api/gps/sats")
    assert r.status_code == 200
    data = r.json()
    assert "ok" in data


def test_time_returns_response(client):
    r = client.get("/api/gps/time")
    assert r.status_code == 200
    data = r.json()
    assert "ok" in data


# --------------------------------------------------------------------------- #
# Helper functions
# --------------------------------------------------------------------------- #
def test_constellation_mapping():
    from warlock.modules.gps import _constellation
    # By PRN range
    assert _constellation({"svid": 5}) == "GPS"
    assert _constellation({"svid": 70}) == "GLONASS"
    assert _constellation({"svid": 130}) == "SBAS"
    assert _constellation({}) == "?"
    assert _constellation({"svid": 999}) == "?"
