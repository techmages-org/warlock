"""Tests for the ESP32 Companion module — device detection, connect/disconnect,
attack gating (engagement required), and error handling."""
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient


import os

# Disable basic auth for tests — must be set BEFORE importing warlock.
os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")


@pytest.fixture(autouse=True)
def _reset_companion():
    """Reset the companion singleton between tests."""
    from warlock.modules import esp32_companion as mod
    old_serial = mod.companion._serial
    old_device = mod.companion._device
    mod.companion._serial = None
    mod.companion._device = None
    yield
    mod.companion._serial = old_serial
    mod.companion._device = old_device


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WARLOCK_DATA_DIR", str(tmp_path))
    from warlock.server import create_app
    return TestClient(create_app())


def test_status_returns_disconnected_by_default(client):
    r = client.get("/api/esp32_companion/status")
    assert r.status_code == 200
    data = r.json()
    assert data["module"] == "esp32_companion"
    assert data["connected"] is False
    assert data["status"] == "disconnected"


def test_detect_returns_devices_list(client):
    r = client.get("/api/esp32_companion/detect")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "devices" in data
    assert "count" in data
    assert isinstance(data["devices"], list)


def test_command_without_connection_returns_409(client):
    r = client.post("/api/esp32_companion/command",
                    json={"command": "scanap"})
    assert r.status_code == 409


def test_attack_without_connection_returns_409(client):
    r = client.post("/api/esp32_companion/attack",
                    json={"attack_type": "deauth"})
    assert r.status_code == 409


def test_scan_without_connection_returns_409(client):
    r = client.get("/api/esp32_companion/scan")
    assert r.status_code == 409


def test_connect_invalid_device_returns_400(client):
    r = client.post("/api/esp32_companion/connect",
                    json={"device": "/dev/does-not-exist-xyz"})
    assert r.status_code == 400


def test_connect_then_status_shows_connected(client, monkeypatch):
    """Mock the serial layer to simulate connecting to a Marauder board."""
    from warlock.modules import esp32_companion as mod

    mock_serial = MagicMock()
    mock_serial.is_open = True
    mock_serial.in_waiting = 0
    mock_serial.read.return_value = b"Marauder v1.0\n>"

    async def fake_connect(self, device, baud=mod.MARAUDER_BAUD):
        self._serial = mock_serial
        self._device = device
        return {"ok": True, "device": device, "baud": baud, "banner": ""}

    monkeypatch.setattr(mod.MarauderCompanion, "connect", fake_connect)

    r = client.post("/api/esp32_companion/connect",
                    json={"device": "/dev/ttyUSB0"})
    assert r.status_code == 200

    r2 = client.get("/api/esp32_companion/status")
    assert r2.json()["connected"] is True


def test_attack_requires_engagement(client, monkeypatch):
    """Even connected, attack must be rejected without an engagement."""
    from warlock.modules import esp32_companion as mod

    # Force the companion to report as connected by giving it a mock serial.
    mock_ser = MagicMock()
    mock_ser.is_open = True
    monkeypatch.setattr(mod.companion, "_serial", mock_ser)

    r = client.post("/api/esp32_companion/attack",
                    json={"attack_type": "deauth"})
    assert r.status_code == 403


def test_stop_without_connection_returns_409(client):
    r = client.post("/api/esp32_companion/stop")
    assert r.status_code == 409


def test_help_without_connection_returns_409(client):
    r = client.get("/api/esp32_companion/help")
    assert r.status_code == 409
