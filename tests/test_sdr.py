"""Unit tests for the SDR module — the SDR-over-WS live bus emitter + the shared
status payload.

The emitter (an on_startup background loop) publishes a compact aircraft summary
(``sdr.adsb``) and a device snapshot (``sdr.status``) every ~3s. No real readsb
feed is ever hit: ``_fetch_readsb_aircraft`` is mocked and ``_status_payload`` is
stubbed where needed, so the tests assert the payload SHAPES + the publish wiring
deterministically.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-sdr-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

import asyncio  # noqa: E402
from unittest.mock import AsyncMock  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from warlock import events  # noqa: E402
import warlock.modules.sdr as sdr  # noqa: E402

# A representative readsb aircraft.json: one positioned + one position-less craft.
_FEED = {
    "now": 1_700_000_000.0,
    "aircraft": [
        {"hex": "a1b2c3", "flight": "UAL123 ", "lat": 30.7, "lon": -97.4,
         "alt_baro": 35000, "gs": 450, "track": 270, "squawk": "1200",
         "rssi": -12.3, "seen": 1.2},
        {"hex": "ddee01", "flight": None, "alt_baro": 5000, "gs": 120,
         "rssi": -20.0, "seen": 8.0},  # no lat/lon
    ],
}


@pytest.fixture(scope="module")
def client():
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


# --------------------------------------------------------------------------- #
# Status payload shape (shared by GET /status + the bus emitter)
# --------------------------------------------------------------------------- #
def test_status_payload_shape():
    p = sdr._status_payload()
    assert p["ok"] is True
    # The web Sdr page + Ink SDR screen consume this exact key set.
    assert set(p) == {
        "ok", "rtl_sdr_detected", "tuner", "device_count", "usb_present",
        "blacklist", "readsb", "rtl_433", "lock", "probe_raw",
    }
    assert "active" in p["readsb"]


def test_status_endpoint_matches_payload(client):
    r = client.get("/api/sdr/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "readsb" in body and "rtl_433" in body and "blacklist" in body


# --------------------------------------------------------------------------- #
# Compact aircraft + adsb bus payload
# --------------------------------------------------------------------------- #
def test_compact_aircraft_subset():
    row = sdr._compact_aircraft(_FEED["aircraft"][0])
    assert row == {
        "icao": "a1b2c3", "callsign": "UAL123", "lat": 30.7, "lon": -97.4,
        "altitude_ft": 35000, "speed_kt": 450, "heading": 270,
        "squawk": "1200", "rssi": -12.3, "seen_s": 1.2,
    }
    # Blank flight string normalises to None.
    assert sdr._compact_aircraft(_FEED["aircraft"][1])["callsign"] is None


def test_adsb_bus_payload_readsb_inactive_is_unavailable():
    out = asyncio.run(sdr._adsb_bus_payload(readsb_active=False))
    assert out["ok"] is False
    assert out["reason"] == "readsb inactive"
    assert out["count"] == 0 and out["aircraft"] == []


def test_adsb_bus_payload_summarises_feed(monkeypatch):
    monkeypatch.setattr(sdr, "_fetch_readsb_aircraft", AsyncMock(return_value=_FEED))
    out = asyncio.run(sdr._adsb_bus_payload(readsb_active=True))
    assert out["ok"] is True
    assert out["now"] == _FEED["now"]
    assert out["count"] == 2
    assert out["with_position"] == 1   # only the first craft has lat/lon
    assert out["truncated"] is False
    assert len(out["aircraft"]) == 2
    assert out["aircraft"][0]["icao"] == "a1b2c3"


def test_adsb_bus_payload_degrades_on_feed_error(monkeypatch):
    monkeypatch.setattr(
        sdr, "_fetch_readsb_aircraft",
        AsyncMock(side_effect=HTTPException(502, "readsb fetch failed: boom")),
    )
    out = asyncio.run(sdr._adsb_bus_payload(readsb_active=True))
    assert out["ok"] is False
    assert "readsb fetch failed" in out["reason"]
    assert out["aircraft"] == []


def test_adsb_bus_payload_caps_and_flags_truncation(monkeypatch):
    big = {"now": 1.0, "aircraft": [{"hex": f"{i:06x}", "lat": 1.0, "lon": 2.0}
                                    for i in range(sdr.SDR_BUS_MAX_AIRCRAFT + 10)]}
    monkeypatch.setattr(sdr, "_fetch_readsb_aircraft", AsyncMock(return_value=big))
    out = asyncio.run(sdr._adsb_bus_payload(readsb_active=True))
    assert out["count"] == sdr.SDR_BUS_MAX_AIRCRAFT + 10  # true count preserved
    assert out["truncated"] is True
    assert len(out["aircraft"]) == sdr.SDR_BUS_MAX_AIRCRAFT  # list capped


# --------------------------------------------------------------------------- #
# _emit_once — publishes BOTH events to the bus with the right shapes
# --------------------------------------------------------------------------- #
def test_emit_once_returns_both_payloads(monkeypatch):
    monkeypatch.setattr(sdr, "_status_payload",
                        lambda: {"ok": True, "readsb": {"active": False}})
    out = asyncio.run(sdr._emit_once())
    assert out["status"]["ok"] is True
    assert out["adsb"]["ok"] is False  # readsb inactive -> unavailable adsb


def test_emit_once_publishes_sdr_status_and_adsb(monkeypatch):
    monkeypatch.setattr(sdr, "_status_payload",
                        lambda: {"ok": True, "readsb": {"active": True}})
    monkeypatch.setattr(sdr, "_fetch_readsb_aircraft", AsyncMock(return_value=_FEED))

    async def run():
        received: list[events.Event] = []
        gen = events.bus.subscribe()

        async def consume():
            async for evt in gen:
                received.append(evt)
                if len(received) >= 2:
                    break

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)  # let the subscriber register its queue
        await sdr._emit_once()
        await asyncio.wait_for(task, timeout=2)
        await gen.aclose()
        return received

    received = asyncio.run(run())
    names = {e.name for e in received}
    assert names == {events.SDR_STATUS, events.SDR_ADSB}
    adsb = next(e for e in received if e.name == events.SDR_ADSB)
    assert adsb.payload["ok"] is True and adsb.payload["count"] == 2
