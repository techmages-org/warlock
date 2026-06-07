"""Unit tests for the offensive SDR module (RF capture / replay / analyze).

Built to the ratified JSON contract (web-p3 / agent-p3): status carries
{rx_device, tx_device, tx_capable, busy, reason, captures[], last_result}; every
action returns {ok, op, detail, audit_id, error, ts, job_id}.

Subprocess is never spawned: the engagement-OFF / out-of-scope paths are refused
by the *real* ``runner.submit`` (which raises before launching any process), and
the in-scope success paths mock ``runner.submit`` + the device probe. ``replay``
is RF-emitting and gated; ``analyze`` is offline + dependency-free (NOT gated).
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-sdroff-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

from datetime import datetime  # noqa: E402
from pathlib import Path  # noqa: E402
from unittest.mock import AsyncMock  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import warlock.modules.sdr_offensive as so  # noqa: E402

IN_TARGET = "garage-remote"    # an in-scope authorising target (stored as an SSID)
OUT_TARGET = "neighbour-gate"  # never in scope


@pytest.fixture(scope="module")
def client():
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


@pytest.fixture(autouse=True)
def _reset_engagement():
    """Engagement starts OFF for every test, and is reset afterwards."""
    from warlock.engagement import ScopeAllowlist, engagement

    def _off() -> None:
        engagement._mode = "off"
        engagement.engagement_id = None
        engagement.name = ""
        engagement.scope = ScopeAllowlist()
        engagement.started_at = None
        engagement.audit_log_path = None

    _off()
    yield
    _off()


def _engage(ssids=None, ip_ranges=None) -> None:
    from warlock.engagement import ScopeAllowlist, engagement

    engagement._mode = "on"
    engagement.engagement_id = "test-eng-sdr"
    engagement.name = "test"
    engagement.scope = ScopeAllowlist(ssids=ssids or [], ip_ranges=ip_ranges or [])
    engagement.started_at = datetime.utcnow()
    engagement.audit_log_path = None  # DB AuditEntry only; no yaml file in tests


def _count_violations(target: str) -> int:
    from warlock.db import session_scope
    from warlock.models import AuditEntry

    with session_scope() as s:
        return (
            s.query(AuditEntry)
            .filter(AuditEntry.kind == "scope.violation", AuditEntry.target == target)
            .count()
        )


_ACTION_KEYS = {"ok", "op", "detail", "audit_id", "error", "ts", "job_id"}


def _mk_capture(name: str = "cap.iq", data: bytes = b"\x10\x20" * 64) -> Path:
    p = so._captures_dir() / name
    p.write_bytes(data)
    return p


# --------------------------------------------------------------------------- #
# Registration + status shape
# --------------------------------------------------------------------------- #
def test_module_registers(client):
    r = client.get("/api/modules")
    assert r.status_code == 200
    mods = {m["id"]: m for m in r.json()}
    assert "sdr_offensive" in mods
    assert mods["sdr_offensive"]["requires_engagement"] is True


def test_status_contract_shape(client):
    r = client.get("/api/sdr_offensive/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # Ratified status keys all present.
    for k in ("rx_device", "tx_device", "tx_capable", "busy", "reason",
              "captures", "last_result", "tools"):
        assert k in body, f"missing status key {k}"
    assert isinstance(body["tx_capable"], bool)
    assert isinstance(body["busy"], bool)
    assert isinstance(body["captures"], list)
    # Additive per-tool dict (Ink screen reads it).
    assert set(body["tools"]) == {"hackrf", "rtl_sdr", "urh"}
    for t in body["tools"].values():
        assert "present" in t and "path" in t
        assert isinstance(t["present"], bool)


def test_status_capture_rows_have_contract_fields(client, monkeypatch):
    monkeypatch.setattr(so, "_captures_dir", lambda: Path(so.get_settings().data) / "captures" / "sdr")
    cap = _mk_capture("rowcheck.iq")
    so._write_meta(cap, freq_mhz=433.92, sample_rate=2_000_000, duration_s=5)
    r = client.get("/api/sdr_offensive/status")
    row = next(c for c in r.json()["captures"] if c["filename"] == "rowcheck.iq")
    for k in ("id", "filename", "path", "freq_mhz", "sample_rate", "duration_s",
              "size_bytes", "created_at", "modulation"):
        assert k in row, f"missing capture-row key {k}"
    assert row["id"] == "rowcheck"          # stable id = filename stem
    assert row["freq_mhz"] == 433.92        # from the sidecar
    cap.unlink()
    so._meta_path(cap).unlink()


# --------------------------------------------------------------------------- #
# Gate: capture refused when engagement OFF / out-of-scope (real runner.submit)
# --------------------------------------------------------------------------- #
def test_capture_refused_when_engagement_off(client):
    before = _count_violations(IN_TARGET)
    r = client.post("/api/sdr_offensive/capture",
                    json={"freq_mhz": 433.92, "target": IN_TARGET})
    assert r.status_code == 403
    assert _count_violations(IN_TARGET) == before + 1  # scope.violation persisted


def test_capture_refused_out_of_scope(client):
    _engage(ssids=[IN_TARGET])
    before = _count_violations(OUT_TARGET)
    r = client.post("/api/sdr_offensive/capture",
                    json={"freq_mhz": 433.92, "target": OUT_TARGET})
    assert r.status_code == 403
    assert _count_violations(OUT_TARGET) == before + 1


# --------------------------------------------------------------------------- #
# Gate: replay (RF emit) — refuse off / out-of-scope
# --------------------------------------------------------------------------- #
def test_replay_refused_when_engagement_off(client):
    before = _count_violations(IN_TARGET)
    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "cap.iq", "freq_mhz": 315.0, "target": IN_TARGET})
    assert r.status_code == 403
    assert _count_violations(IN_TARGET) == before + 1


def test_replay_refused_out_of_scope(client):
    _engage(ssids=[IN_TARGET])
    before = _count_violations(OUT_TARGET)
    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "cap.iq", "freq_mhz": 315.0, "target": OUT_TARGET})
    assert r.status_code == 403
    assert _count_violations(OUT_TARGET) == before + 1


# --------------------------------------------------------------------------- #
# Happy path: in-scope + device present -> runner.submit gets the right argv,
# response carries the uniform action shape.
# --------------------------------------------------------------------------- #
def test_capture_in_scope_submits_gated(client, monkeypatch):
    _engage(ssids=[IN_TARGET])
    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["type"] = type_
        captured["argv"] = argv
        captured["kw"] = kw
        return "job-cap"

    monkeypatch.setattr(so.runner, "submit", fake_submit)
    monkeypatch.setattr(so, "_rx_device", lambda: "hackrf")  # pretend a radio is present

    r = client.post("/api/sdr_offensive/capture",
                    json={"freq_mhz": 433.92, "sample_rate": 2_000_000,
                          "duration_s": 3, "target": IN_TARGET})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) >= _ACTION_KEYS               # uniform action shape
    assert body["ok"] is True and body["op"] == "capture"
    assert body["job_id"] == "job-cap"
    assert captured["type"] == "sdr.capture"
    assert captured["kw"]["requires_engagement"] is True  # gate not bypassed
    assert captured["kw"]["target"] == IN_TARGET
    assert "hackrf_transfer" in " ".join(captured["argv"])
    assert "-r" in captured["argv"]                # receive (RX) mode
    # MHz -> Hz conversion is rounded, not truncated.
    assert captured["argv"][captured["argv"].index("-f") + 1] == "433920000"


def test_replay_in_scope_submits_gated(client, monkeypatch):
    _engage(ssids=[IN_TARGET])
    _mk_capture("replay.iq")
    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["type"] = type_
        captured["argv"] = argv
        captured["kw"] = kw
        return "job-tx"

    monkeypatch.setattr(so.runner, "submit", fake_submit)
    monkeypatch.setattr(so, "_tool_missing", lambda t: False)

    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "replay.iq", "freq_mhz": 315.0,
                          "sample_rate": 2_000_000, "tx_gain": 20, "target": IN_TARGET})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) >= _ACTION_KEYS
    assert body["ok"] is True and body["op"] == "replay"
    assert body["job_id"] == "job-tx"
    assert captured["type"] == "sdr.replay"
    assert captured["kw"]["requires_engagement"] is True
    assert captured["kw"]["target"] == IN_TARGET   # scope gate when a target is given
    assert "-t" in captured["argv"]                # transmit (TX) mode


def test_replay_in_scope_resolves_by_path(client, monkeypatch):
    _engage(ssids=[IN_TARGET])
    cap = _mk_capture("bypath.iq")
    captured: dict = {}

    async def fake_submit(type_, argv, **kw):
        captured["argv"] = argv
        return "job-p"

    monkeypatch.setattr(so.runner, "submit", fake_submit)
    monkeypatch.setattr(so, "_tool_missing", lambda t: False)

    r = client.post("/api/sdr_offensive/replay",
                    json={"path": cap.as_posix(), "freq_mhz": 315.0, "target": IN_TARGET})
    assert r.status_code == 200, r.text
    assert cap.as_posix() in captured["argv"]


# --------------------------------------------------------------------------- #
# Unavailable: authorised op, but no device -> clean result, no crash, no submit
# --------------------------------------------------------------------------- #
def test_capture_unavailable_when_no_rx_device(client, monkeypatch):
    _engage(ssids=[IN_TARGET])
    submit = AsyncMock(return_value="should-not-run")
    monkeypatch.setattr(so.runner, "submit", submit)
    monkeypatch.setattr(so, "_rx_device", lambda: None)  # no RX radio

    r = client.post("/api/sdr_offensive/capture",
                    json={"freq_mhz": 433.92, "target": IN_TARGET})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False and body["error"] == "unavailable"
    assert body["job_id"] is None
    submit.assert_not_awaited()  # never reached the runner


def test_replay_unavailable_when_tx_missing(client, monkeypatch):
    _engage(ssids=[IN_TARGET])
    _mk_capture("u.iq")
    submit = AsyncMock(return_value="should-not-run")
    monkeypatch.setattr(so.runner, "submit", submit)
    monkeypatch.setattr(so, "_tool_missing", lambda t: True)

    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "u.iq", "freq_mhz": 315.0, "target": IN_TARGET})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False and body["error"] == "unavailable"
    submit.assert_not_awaited()


# --------------------------------------------------------------------------- #
# Validation / path-safety
# --------------------------------------------------------------------------- #
def test_capture_freq_out_of_bounds_rejected(client):
    _engage(ssids=[IN_TARGET])
    r = client.post("/api/sdr_offensive/capture",
                    json={"freq_mhz": 0.1, "target": IN_TARGET})  # below 1 MHz floor
    assert r.status_code == 422


def test_replay_requires_a_capture_reference(client):
    _engage(ssids=[IN_TARGET])
    r = client.post("/api/sdr_offensive/replay",
                    json={"freq_mhz": 315.0, "target": IN_TARGET})  # no capture/path
    assert r.status_code == 400


def test_replay_target_is_required(client):
    # RF emission MUST carry an authorising target — omitting it is a 422.
    _engage(ssids=[IN_TARGET])
    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "cap.iq", "freq_mhz": 315.0})  # no target
    assert r.status_code == 422


def test_replay_rejects_whitespace_target(client):
    # A whitespace-only target passes pydantic min_length=1 but must NOT slip
    # through as an empty (unscoped) target under an active engagement.
    _engage(ssids=[IN_TARGET])
    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "cap.iq", "freq_mhz": 315.0, "target": "   "})
    assert r.status_code == 400


def test_replay_rejects_path_traversal(client):
    _engage(ssids=[IN_TARGET])
    r = client.post("/api/sdr_offensive/replay",
                    json={"capture": "/etc/shadow", "freq_mhz": 315.0, "target": IN_TARGET})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# analyze — offline, dependency-free, NOT engagement-gated
# --------------------------------------------------------------------------- #
def test_analyze_summary_no_gate(client):
    # Engagement is OFF (autouse) — analyze must still work (light, no gate).
    cap = _mk_capture("analyze.iq", data=bytes(range(256)) * 8)
    so._write_meta(cap, freq_mhz=433.92, sample_rate=2_000_000, duration_s=1)
    r = client.post("/api/sdr_offensive/analyze", json={"capture": "analyze.iq"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) >= _ACTION_KEYS
    assert body["ok"] is True and body["op"] == "analyze"
    assert "samples" in body["detail"] and "rms=" in body["detail"]


def test_analyze_missing_capture_404(client):
    r = client.post("/api/sdr_offensive/analyze", json={"capture": "nope.iq"})
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# last_result — status reflects the most recent action
# --------------------------------------------------------------------------- #
def test_status_last_result_tracks_actions(client, monkeypatch):
    _engage(ssids=[IN_TARGET])
    monkeypatch.setattr(so.runner, "submit", AsyncMock(return_value="job-lr"))
    monkeypatch.setattr(so, "_rx_device", lambda: "hackrf")
    client.post("/api/sdr_offensive/capture", json={"freq_mhz": 868.0, "target": IN_TARGET})

    lr = client.get("/api/sdr_offensive/status").json()["last_result"]
    assert lr is not None
    assert lr["op"] == "capture" and lr["ok"] is True
    assert set(lr) >= {"ok", "op", "detail", "audit_id", "error", "ts"}


# --------------------------------------------------------------------------- #
# Pure command builders — assert structure (no gate, no I/O)
# --------------------------------------------------------------------------- #
def test_capture_command_hackrf(tmp_path):
    argv = so._capture_command(tool="hackrf", freq_hz=433_920_000,
                               sample_rate=2_000_000, duration_s=4, outfile=tmp_path / "c.iq")
    assert argv[0] == "timeout"               # bounded so capture can't run forever
    assert any(a.endswith("hackrf_transfer") for a in argv)
    assert argv[argv.index("-f") + 1] == "433920000"
    assert argv[argv.index("-n") + 1] == str(2_000_000 * 4)  # sample-count cap
    assert "-r" in argv                        # receive mode


def test_capture_command_rtl_sdr(tmp_path):
    argv = so._capture_command(tool="rtl_sdr", freq_hz=315_000_000,
                               sample_rate=2_000_000, duration_s=2, outfile=tmp_path / "c.iq")
    assert argv[0] == "timeout"
    assert any(a.endswith("rtl_sdr") for a in argv)
    assert str(tmp_path / "c.iq") in argv      # rtl_sdr takes the outfile positionally


def test_replay_command_transmits(tmp_path):
    argv = so._replay_command(capture=tmp_path / "c.iq", freq_hz=315_000_000,
                              sample_rate=2_000_000, tx_gain=30)
    assert argv[0] == "timeout"                # TX bounded too
    assert any(a.endswith("hackrf_transfer") for a in argv)
    assert "-t" in argv                        # transmit mode (RF emit)
    assert argv[argv.index("-x") + 1] == "30"  # TX gain
