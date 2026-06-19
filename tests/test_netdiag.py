"""Tests for the Netdiag module — helper functions and RFC1918 logic."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest


# --------------------------------------------------------------------------- #
# RFC 1918 private address detection
# --------------------------------------------------------------------------- #
def test_is_rfc1918_private_addresses():
    from warlock.modules.netdiag import _is_rfc1918
    assert _is_rfc1918("10.0.0.1") is True
    assert _is_rfc1918("10.255.255.255") is True
    assert _is_rfc1918("172.16.0.1") is True
    assert _is_rfc1918("172.31.255.255") is True
    assert _is_rfc1918("192.168.1.1") is True
    assert _is_rfc1918("192.168.0.0") is True


def test_is_rfc1918_public_addresses():
    from warlock.modules.netdiag import _is_rfc1918
    assert _is_rfc1918("8.8.8.8") is False
    assert _is_rfc1918("1.1.1.1") is False
    assert _is_rfc1918("172.15.0.1") is False  # just below 172.16
    assert _is_rfc1918("172.32.0.1") is False  # just above 172.31
    assert _is_rfc1918("11.0.0.1") is False
    assert _is_rfc1918("192.169.1.1") is False


def test_is_rfc1918_edge_cases():
    from warlock.modules.netdiag import _is_rfc1918
    assert _is_rfc1918("172.16.0.0") is True   # boundary
    assert _is_rfc1918("172.31.0.0") is True   # boundary
    assert _is_rfc1918("172.15.255.255") is False
    assert _is_rfc1918("192.167.255.255") is False


# --------------------------------------------------------------------------- #
# SHA256 audit hash
# --------------------------------------------------------------------------- #
def test_sha256_audit_hash():
    from warlock.modules.netdiag import _sha256
    h = _sha256("test command")
    assert len(h) == 64
    assert h == _sha256("test command")  # deterministic
    assert h != _sha256("different")
