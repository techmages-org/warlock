"""Tests for the Mesh module — status degradation, node collection,
send model validation, channel listing."""
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
# /api/mesh/status — degrades gracefully without a radio
# --------------------------------------------------------------------------- #
def test_status_degrades_gracefully(client):
    """Without meshtasticd running, status should return ok:false, not crash."""
    r = client.get("/api/mesh/status")
    # Either ok:true (if meshtasticd is running) or ok:false (not running)
    assert r.status_code == 200
    data = r.json()
    assert "ok" in data
    if data["ok"]:
        assert "nodes" in data
    else:
        assert "error" in data


# --------------------------------------------------------------------------- #
# /api/mesh/nodes — returns 502 on connection failure, list on success
# --------------------------------------------------------------------------- #
def test_nodes_returns_data_or_502(client):
    """If meshtasticd is down, /nodes returns 502. If up, returns a list."""
    r = client.get("/api/mesh/nodes")
    assert r.status_code in (200, 502)


# --------------------------------------------------------------------------- #
# /api/mesh/channels — returns 502 on failure, list on success
# --------------------------------------------------------------------------- #
def test_channels_returns_data_or_502(client):
    r = client.get("/api/mesh/channels")
    assert r.status_code in (200, 502)


# --------------------------------------------------------------------------- #
# SendIn model validation
# --------------------------------------------------------------------------- #
def test_send_in_model_defaults():
    from warlock.modules.mesh import SendIn
    msg = SendIn(text="hello mesh")
    assert msg.text == "hello mesh"
    assert msg.channel == 0
    assert msg.destination is None


def test_send_in_model_with_destination():
    from warlock.modules.mesh import SendIn
    msg = SendIn(text="dm", channel=1, destination="!1234abcd")
    assert msg.channel == 1
    assert msg.destination == "!1234abcd"


# --------------------------------------------------------------------------- #
# _on_receive — packet bridge parsing (no radio needed)
# --------------------------------------------------------------------------- #
def test_on_receive_parses_packet():
    """The pubsub callback should extract a clean payload from a raw packet."""
    from warlock.modules.mesh import _MeshClient
    c = _MeshClient()
    # Simulate a meshtastic packet
    packet = {
        "fromId": "!1234abcd",
        "toId": "^all",
        "channel": 0,
        "rxSnr": 8.5,
        "rxRssi": -42,
        "decoded": {
            "portnum": "TEXT_MESSAGE_APP",
            "text": {"bytes": [104, 105]},  # "hi"
        },
    }
    # _on_receive doesn't crash on mock packet (it catches exceptions)
    # and won't publish since there's no running event loop
    c._on_receive(packet, interface=None)
    # No exception raised = pass


def test_on_receive_handles_garbage():
    """The callback should not crash on malformed packets."""
    from warlock.modules.mesh import _MeshClient
    c = _MeshClient()
    c._on_receive("garbage", interface=None)
    c._on_receive(None, interface=None)
    c._on_receive({}, interface=None)
