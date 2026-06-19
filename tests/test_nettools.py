"""Tests for the Nettools module — MAC parsing, OUI lookup, subnet calc,
endpoint structure, and request model validation."""
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
# _mac_bytes — MAC address parsing/validation
# --------------------------------------------------------------------------- #
def test_mac_bytes_valid_formats():
    from warlock.modules.nettools import _mac_bytes
    # Colon-separated
    assert _mac_bytes("AA:BB:CC:DD:EE:FF") == b"\xaa\xbb\xcc\xdd\xee\xff"
    # Dash-separated
    assert _mac_bytes("AA-BB-CC-DD-EE-FF") == b"\xaa\xbb\xcc\xdd\xee\xff"
    # Dot-separated (Cisco)
    assert _mac_bytes("AABB.CCDD.EEFF") == b"\xaa\xbb\xcc\xdd\xee\xff"
    # Bare hex
    assert _mac_bytes("AABBCCDDEEFF") == b"\xaa\xbb\xcc\xdd\xee\xff"
    # Lowercase
    assert _mac_bytes("aa:bb:cc:dd:ee:ff") == b"\xaa\xbb\xcc\xdd\xee\xff"


def test_mac_bytes_rejects_invalid():
    from fastapi import HTTPException
    from warlock.modules.nettools import _mac_bytes
    with pytest.raises(HTTPException) as exc:
        _mac_bytes("not-a-mac")
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        _mac_bytes("AA:BB:CC")  # too short
    with pytest.raises(HTTPException):
        _mac_bytes("ZZ:BB:CC:DD:EE:FF")  # non-hex


# --------------------------------------------------------------------------- #
# /api/nettools/status
# --------------------------------------------------------------------------- #
def test_status_returns_info(client):
    r = client.get("/api/nettools/status")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "oui_entries" in data
    assert "curl" in data
    assert "subnet" in data["checks"]


# --------------------------------------------------------------------------- #
# /api/nettools/subnet
# --------------------------------------------------------------------------- #
def test_subnet_ipv4(client):
    r = client.post("/api/nettools/subnet", json={"cidr": "192.168.1.0/24"})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["network"] == "192.168.1.0"
    assert data["prefix"] == 24
    assert data["total_addresses"] == 256
    assert data["usable_hosts"] == 254
    assert data["first_host"] == "192.168.1.1"
    assert data["last_host"] == "192.168.1.254"
    assert data["netmask"] == "255.255.255.0"
    assert data["broadcast"] == "192.168.1.255"
    assert data["version"] == 4


def test_subnet_small_net(client):
    r = client.post("/api/nettools/subnet", json={"cidr": "10.0.0.0/30"})
    assert r.status_code == 200
    data = r.json()
    assert data["total_addresses"] == 4
    assert data["usable_hosts"] == 2


def test_subnet_rejects_bad_cidr(client):
    r = client.post("/api/nettools/subnet", json={"cidr": "not-a-network"})
    assert r.status_code == 400


def test_subnet_slash32_single_host(client):
    """A /32 has 1 address and Python counts it as 1 usable host."""
    r = client.post("/api/nettools/subnet", json={"cidr": "192.168.1.5/32"})
    assert r.status_code == 200
    data = r.json()
    assert data["total_addresses"] == 1
    assert data["usable_hosts"] == 1


# --------------------------------------------------------------------------- #
# /api/nettools/oui
# --------------------------------------------------------------------------- #
def test_oui_rejects_bad_mac(client):
    r = client.post("/api/nettools/oui", json={"mac": "garbage"})
    assert r.status_code == 400
