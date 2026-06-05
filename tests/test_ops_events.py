"""Unit tests for the ops activity/loot feed ("the pager").

Covers the three moving parts of the feed:

* ``_EventRing`` — the bounded, newest-first ring buffer (cap + ordering).
* ``_consume_bus`` — the bus subscriber, driven against a *mocked* bus (a
  finite async generator) so the test is deterministic and never depends on
  asyncio delivery timing.
* ``GET /api/ops/events`` — the endpoint shape: every row is
  ``{ts, source, severity, kind, text}``, newest-first, with recent audit rows
  folded in (and ``audit=0`` returning just the bus alert ring).
"""
from __future__ import annotations

import asyncio
import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-ev-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

from datetime import datetime, timedelta  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from warlock import events  # noqa: E402
from warlock.modules import ops  # noqa: E402


@pytest.fixture(scope="module")
def client():
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


@pytest.fixture(autouse=True)
def _clean_ring():
    """The ring is a module-global singleton — isolate every test."""
    ops._event_ring.clear()
    yield
    ops._event_ring.clear()


def _alert(source: str, severity: str, message: str, ts: str) -> events.Event:
    e = events.Event(name=events.ALERT_FIRED, payload={
        "source": source, "severity": severity, "message": message,
    })
    e.ts = ts  # deterministic ordering
    return e


# --------------------------------------------------------------------------- #
# Ring buffer
# --------------------------------------------------------------------------- #
def test_ring_caps_and_orders_newest_first():
    ring = ops._EventRing(maxlen=3)
    for i in range(5):
        ring.push({"ts": f"t{i}", "n": i})
    snap = ring.snapshot()
    # Oldest two evicted; newest-first.
    assert [r["n"] for r in snap] == [4, 3, 2]
    assert len(snap) == 3


def test_ring_snapshot_is_a_copy():
    ring = ops._EventRing(maxlen=5)
    ring.push({"n": 1})
    snap = ring.snapshot()
    snap.append({"n": 99})
    assert len(ring.snapshot()) == 1  # mutating the snapshot doesn't touch the ring


# --------------------------------------------------------------------------- #
# Normalisers
# --------------------------------------------------------------------------- #
def test_norm_alert_shape():
    row = ops._norm_alert(_alert("net_recon", "critical", "new device 10.0.0.9", "2026-06-04T10:00:00"))
    assert row == {
        "ts": "2026-06-04T10:00:00",
        "source": "net_recon",
        "severity": "critical",
        "kind": "alert",
        "text": "new device 10.0.0.9",
    }


def test_norm_alert_defaults_for_empty_payload():
    evt = events.Event(name=events.ALERT_FIRED, payload={})
    row = ops._norm_alert(evt)
    assert row["source"] == "system"
    assert row["severity"] == "info"
    assert row["kind"] == "alert"
    assert row["text"] == events.ALERT_FIRED  # falls back to the event name


# --------------------------------------------------------------------------- #
# Bus subscriber (mocked bus)
# --------------------------------------------------------------------------- #
def test_consume_bus_records_only_alert_events(monkeypatch):
    feed = [
        _alert("wireless_ids", "warning", "rogue AP", "2026-06-04T10:00:01"),
        events.Event(name=events.JOB_FINISHED, payload={"id": "x"}),  # ignored
        _alert("crack", "critical", "wpa2 cracked", "2026-06-04T10:00:02"),
    ]

    async def _fake_subscribe():
        for e in feed:
            yield e

    monkeypatch.setattr(events.bus, "subscribe", _fake_subscribe)
    asyncio.run(ops._consume_bus())

    snap = ops._event_ring.snapshot()
    assert len(snap) == 2  # the JOB_FINISHED event was filtered out
    assert [r["text"] for r in snap] == ["wpa2 cracked", "rogue AP"]  # newest-first
    assert snap[0]["source"] == "crack"


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #
def _seed_audit_rows():
    from warlock.db import session_scope
    from warlock.models import AuditEntry

    base = datetime(2026, 6, 4, 9, 0, 0)
    with session_scope() as s:
        s.add_all([
            AuditEntry(
                ts=base, kind="job.submit", command="nmap -sS 10.0.0.0/24",
                target="10.0.0.0/24", note="quick scan", outcome="submitted",
            ),
            AuditEntry(
                ts=base + timedelta(minutes=1), kind="scope.violation",
                command="aireplay-ng --deauth", target="11:22:33:44:55:66",
                note="out-of-scope: deauth", outcome="refused",
            ),
        ])


def test_events_endpoint_shape_and_merge(client):
    # NOTE: the SQLite DB is shared across test modules, so other suites may have
    # seeded extra audit rows. Assertions here check membership/shape/ordering,
    # never an exact total, so the test is robust to that pollution.
    _seed_audit_rows()
    # Two live bus alerts in the ring, timestamped in the far future so they sort
    # to the very top regardless of any other audit rows already in the DB.
    ops._event_ring.push(ops._norm_alert(
        _alert("net_recon", "critical", "new device", "2099-06-04T12:00:00")))
    ops._event_ring.push(ops._norm_alert(
        _alert("wireless_ids", "warning", "evil twin", "2099-06-04T12:00:05")))

    r = client.get("/api/ops/events")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["count"] == len(body["events"])

    events_out = body["events"]

    # Every row carries exactly the documented feed shape.
    for row in events_out:
        assert set(row.keys()) == {"ts", "source", "severity", "kind", "text"}

    # Newest-first overall.
    ts_list = [row["ts"] for row in events_out]
    assert ts_list == sorted(ts_list, reverse=True)

    # Both bus alerts present and (being far-future) at the very top.
    assert events_out[0]["text"] == "evil twin"
    assert events_out[1]["text"] == "new device"

    # Audit folding: at least one ops-sourced audit row was merged in, and every
    # scope.violation row is flagged warning.
    assert any(e["source"] == "ops" for e in events_out)
    for e in events_out:
        if e["kind"] == "scope.violation":
            assert e["severity"] == "warning"
            assert e["source"] == "ops"


def test_events_endpoint_audit_off_returns_only_ring(client):
    _seed_audit_rows()
    ops._event_ring.push(ops._norm_alert(
        _alert("crack", "critical", "ring-only", "2026-06-04T13:00:00")))

    r = client.get("/api/ops/events?audit=0")
    assert r.status_code == 200
    events_out = r.json()["events"]
    assert len(events_out) == 1
    assert events_out[0]["text"] == "ring-only"
    assert events_out[0]["kind"] == "alert"


def test_events_endpoint_limit_is_clamped(client):
    for i in range(10):
        ops._event_ring.push(ops._norm_alert(
            _alert("net_recon", "info", f"evt{i}", f"2026-06-04T14:00:{i:02d}")))

    r = client.get("/api/ops/events?audit=0&limit=3")
    assert r.status_code == 200
    assert len(r.json()["events"]) == 3
