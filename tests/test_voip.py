"""Tests for the VoIP module — MOS/R-factor calculation, quality classification,
capture ID validation, and DSCP name mapping."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest


# --------------------------------------------------------------------------- #
# _mos — E-model MOS/R-factor calculation
# --------------------------------------------------------------------------- #
def test_mos_perfect_conditions():
    from warlock.modules.voip import _mos
    mos, r = _mos(loss_pct=0.0, mean_jitter_ms=0.0)
    assert mos >= 4.3
    assert r >= 90


def test_mos_with_loss():
    from warlock.modules.voip import _mos
    mos, r = _mos(loss_pct=10.0, mean_jitter_ms=20.0)
    assert mos < 4.0
    assert r < 90


def test_mos_degrades_with_jitter():
    from warlock.modules.voip import _mos
    m_good, _ = _mos(loss_pct=0.0, mean_jitter_ms=1.0)
    m_bad, _ = _mos(loss_pct=0.0, mean_jitter_ms=50.0)
    assert m_good > m_bad


def test_mos_clamped():
    from warlock.modules.voip import _mos
    mos, r = _mos(loss_pct=100.0, mean_jitter_ms=200.0)
    assert mos >= 1.0
    assert mos <= 4.5
    assert r >= 0.0


def test_mos_zero_loss_high_quality():
    from warlock.modules.voip import _mos
    mos, _ = _mos(loss_pct=0.0, mean_jitter_ms=2.0)
    assert mos >= 4.0  # should be "good" or better


# --------------------------------------------------------------------------- #
# _quality — MOS quality label
# --------------------------------------------------------------------------- #
def test_quality_thresholds():
    from warlock.modules.voip import _quality
    assert _quality(4.5) == "excellent"
    assert _quality(4.3) == "excellent"
    assert _quality(4.2) == "good"
    assert _quality(4.0) == "good"
    assert _quality(3.8) == "fair"
    assert _quality(3.6) == "fair"
    assert _quality(3.3) == "poor"
    assert _quality(3.1) == "poor"
    assert _quality(2.5) == "bad"
    assert _quality(1.0) == "bad"


# --------------------------------------------------------------------------- #
# _cap_path — capture ID validation
# --------------------------------------------------------------------------- #
def test_cap_path_rejects_bad_id():
    from fastapi import HTTPException
    from warlock.modules.voip import _cap_path
    with pytest.raises(HTTPException) as exc:
        _cap_path("../../etc/passwd")
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        _cap_path("garbage")
    with pytest.raises(HTTPException):
        _cap_path("")


def test_cap_path_valid_format():
    """Valid format should return a Path (may not exist on disk)."""
    from warlock.modules.voip import _cap_path
    p = _cap_path("cap-1234567890-deadbe")
    assert "cap-1234567890-deadbe.pcap" in str(p)


# --------------------------------------------------------------------------- #
# DSCP name mapping
# --------------------------------------------------------------------------- #
def test_dscp_names():
    from warlock.modules.voip import _DSCP_NAME
    assert _DSCP_NAME[46] == "EF (voice)"
    assert _DSCP_NAME[0] == "BE (best-effort/unmarked)"
    assert _DSCP_NAME[34] == "AF41"
