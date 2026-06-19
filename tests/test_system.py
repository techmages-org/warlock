"""Tests for the System module — service management, AIO rails,
journal, and network endpoints."""
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
# /api/system/status — hardware telemetry
# --------------------------------------------------------------------------- #
def test_status_returns_hardware_info(client):
    r = client.get("/api/system/status")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "hostname" in data
    assert "uptime_s" in data
    assert "temp_c" in data
    assert "memory" in data
    assert "total_mb" in data["memory"]
    assert "disk_root" in data
    assert "cpu_percent" in data


# --------------------------------------------------------------------------- #
# /api/system/aio — GPIO rail state
# --------------------------------------------------------------------------- #
def test_aio_returns_all_rails(client):
    r = client.get("/api/system/aio")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    rails = data["rails"]
    # All known rails should be present
    for expected in ("gps", "lora", "internal_usb", "spare6", "spare7"):
        assert expected in rails, f"missing rail: {expected}"
        assert "gpio" in rails[expected]
        assert "label" in rails[expected]


def test_aio_on_unknown_rail_404(client):
    r = client.post("/api/system/aio/nonexistent/on")
    assert r.status_code == 404


def test_aio_off_unknown_rail_404(client):
    r = client.post("/api/system/aio/nonexistent/off")
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# /api/system/services — service control
# --------------------------------------------------------------------------- #
def test_services_list(client):
    r = client.get("/api/system/services")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert isinstance(data["services"], list)
    assert len(data["services"]) > 0
    # Each service should have required fields
    for svc in data["services"]:
        assert "unit" in svc
        assert "active" in svc


def test_service_action_rejects_unknown_service(client):
    r = client.post("/api/system/services/notreal/start")
    assert r.status_code == 404


def test_service_action_rejects_invalid_action(client):
    r = client.post("/api/system/services/warlock/hack")
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# /api/system/journal — input validation
# --------------------------------------------------------------------------- #
def test_journal_rejects_invalid_unit_name(client):
    """Unit names must be alphanumeric + dash/underscore/dot/@ — no shell injection."""
    r = client.get("/api/system/journal", params={"unit": "warlock; rm -rf /"})
    assert r.status_code == 400


def test_journal_rejects_invalid_since(client):
    """Since parameter must be clean — no shell injection."""
    r = client.get("/api/system/journal", params={"since": "$(reboot)"})
    assert r.status_code == 400


def test_journal_returns_lines(client):
    r = client.get("/api/system/journal", params={"lines": 5, "priority": 7})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "lines" in data
    assert isinstance(data["lines"], list)


# --------------------------------------------------------------------------- #
# /api/system/network — interface enumeration
# --------------------------------------------------------------------------- #
def test_network_returns_interfaces(client):
    r = client.get("/api/system/network")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert isinstance(data["interfaces"], list)
    # Loopback should always exist
    names = [i["name"] for i in data["interfaces"]]
    assert "lo" in names
    # Each interface should have a type
    for iface in data["interfaces"]:
        assert "type" in iface
        assert "up" in iface
