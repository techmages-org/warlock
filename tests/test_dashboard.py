"""Tests for the dashboard /status endpoint.

Two things are proven:
  * the response still carries the FULL telemetry shape (no field dropped when the
    blocking subprocess probes were offloaded to threads);
  * the five synchronous subprocess probes now run OFF the event-loop thread
    (via asyncio.to_thread) — the P0 fix for the ~5-10s event-loop stall. We
    assert this by comparing the thread a sync probe runs on against the thread
    an awaited async probe runs on (the event loop): they must differ.

No real subprocess ever runs — every probe is monkeypatched to a fast stub.
"""
from __future__ import annotations

import os
import tempfile
import threading

os.environ.setdefault("WARLOCK_DATA", tempfile.mkdtemp(prefix="warlock-dash-"))
os.environ.setdefault("WARLOCK_WEB_PASSWORD", "")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import warlock.modules.dashboard as dash  # noqa: E402


@pytest.fixture(scope="module")
def client():
    app = FastAPI()
    app.include_router(dash.Module().router())
    with TestClient(app) as tc:
        yield tc


def _stub_probes(monkeypatch):
    """Fast, deterministic stand-ins for every probe (no subprocess / network)."""
    monkeypatch.setattr(dash, "_read_cpu_temp_c", lambda: 41.0)
    monkeypatch.setattr(dash, "_vcgencmd_throttled", lambda: "throttled=0x0")
    monkeypatch.setattr(dash, "_rtc_drift_seconds", lambda: 0.012)
    monkeypatch.setattr(dash, "_chrony_tracking", lambda: {"ok": True, "stratum": 2})
    monkeypatch.setattr(
        dash, "_nmcli_active",
        lambda: [{"name": "wlan0", "device": "wlan0", "state": "activated", "type": "wifi"}],
    )
    monkeypatch.setattr(dash, "_sdr_devices", lambda: {"ok": True, "count": 1})

    async def _gps():
        return {"ok": False, "reason": "gpsd unreachable"}

    async def _mesh():
        return 3

    monkeypatch.setattr(dash, "_gpsd_fix", _gps)
    monkeypatch.setattr(dash, "_mesh_node_count", _mesh)


def test_status_returns_full_shape(client, monkeypatch):
    _stub_probes(monkeypatch)
    r = client.get("/api/dashboard/status")
    assert r.status_code == 200, r.text
    body = r.json()

    for key in (
        "hostname", "now", "cpu", "memory", "temp_c", "temp_f", "throttled",
        "disk_root_mb_free", "disk_root_percent", "rtc_drift_s", "chrony",
        "gps", "nmcli_active", "mesh_node_count", "sdr", "engagement",
    ):
        assert key in body, f"missing dashboard field: {key}"

    # Nested shapes preserved.
    for k in ("load_1m", "load_5m", "load_15m", "count", "percent"):
        assert k in body["cpu"]
    for k in ("total_mb", "available_mb", "percent"):
        assert k in body["memory"]

    # Offloaded probe values flow through unchanged.
    assert body["throttled"] == "throttled=0x0"
    assert body["rtc_drift_s"] == 0.012
    assert body["chrony"] == {"ok": True, "stratum": 2}
    assert body["sdr"] == {"ok": True, "count": 1}
    assert body["mesh_node_count"] == 3
    assert body["gps"]["ok"] is False
    assert body["nmcli_active"][0]["device"] == "wlan0"
    assert body["temp_c"] == 41.0 and body["temp_f"] == 105.8
    assert body["engagement"]["mode"] in ("on", "off")


def test_blocking_probes_run_off_event_loop(client, monkeypatch):
    """A sync probe must execute on a worker thread (to_thread), NOT the event
    loop thread — otherwise it would block all concurrent requests."""
    _stub_probes(monkeypatch)
    seen: dict[str, int] = {}

    async def _gps_capture():
        # Awaited directly on the event loop → records the loop thread id.
        seen["loop"] = threading.get_ident()
        return {"ok": False}

    def _chrony_capture():
        # Should be dispatched via asyncio.to_thread → a different worker thread.
        seen["chrony"] = threading.get_ident()
        return {"ok": True}

    monkeypatch.setattr(dash, "_gpsd_fix", _gps_capture)
    monkeypatch.setattr(dash, "_chrony_tracking", _chrony_capture)

    r = client.get("/api/dashboard/status")
    assert r.status_code == 200
    assert "loop" in seen and "chrony" in seen
    assert seen["chrony"] != seen["loop"], (
        "blocking probe ran on the event-loop thread — to_thread offload regressed"
    )
