"""Unit tests for the engagement kill switch (warlock.engagement).

Focus: the emergency ``killswitch()`` must reach ALL offensive activity. The
shared ``runner`` only owns its own processes, while the crack queue and the
server_audit queue run their own managed async queues. So the kill switch must
cancel runner + crack queue + audit queue — and each module is guarded
independently so a missing/broken module can NEVER stop the kill switch or the
other queues from being cancelled.

No real processes ever run: every ``cancel_all`` is monkeypatched with a tiny
recording coroutine, so this asserts the WIRING (who gets cancelled) rather than
the queue internals (covered by test_crack / test_server_audit).
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB and
# the kill switch log lands in a tempdir.
os.environ.setdefault("WARLOCK_DATA", tempfile.mkdtemp(prefix="warlock-engagement-"))
os.environ.setdefault("WARLOCK_WEB_PASSWORD", "")

import asyncio  # noqa: E402


def test_killswitch_cancels_runner_crack_and_audit_queues(monkeypatch):
    """killswitch() fans out to runner + crack queue + audit queue."""
    from warlock.engagement import EngagementMode
    from warlock.jobs import runner
    from warlock.modules import crack, server_audit

    calls = {"runner": 0, "crack": 0, "audit": 0}

    async def fake_runner_cancel() -> int:
        calls["runner"] += 1
        return 2

    async def fake_crack_cancel() -> int:
        calls["crack"] += 1
        return 3

    async def fake_audit_cancel() -> int:
        calls["audit"] += 1
        return 1

    monkeypatch.setattr(runner, "cancel_all", fake_runner_cancel)
    monkeypatch.setattr(crack.queue, "cancel_all", fake_crack_cancel)
    monkeypatch.setattr(server_audit.queue, "cancel_all", fake_audit_cancel)

    line = asyncio.run(EngagementMode().killswitch())

    # Every offensive surface was cancelled exactly once.
    assert calls == {"runner": 1, "crack": 1, "audit": 1}
    # ...and the per-queue counts are surfaced in the kill switch record.
    assert line["cancelled_jobs"] == 2
    assert line["crack_jobs_cancelled"] == 3
    assert line["audit_jobs_cancelled"] == 1


def test_killswitch_guards_failing_crack_queue(monkeypatch):
    """A crashing crack queue must NOT break the kill switch — runner + audit
    still get cancelled, and the failed queue's count stays 0."""
    from warlock.engagement import EngagementMode
    from warlock.jobs import runner
    from warlock.modules import crack, server_audit

    calls = {"runner": 0, "audit": 0}

    async def fake_runner_cancel() -> int:
        calls["runner"] += 1
        return 0

    async def boom() -> int:
        raise RuntimeError("crack queue exploded")

    async def fake_audit_cancel() -> int:
        calls["audit"] += 1
        return 5

    monkeypatch.setattr(runner, "cancel_all", fake_runner_cancel)
    monkeypatch.setattr(crack.queue, "cancel_all", boom)
    monkeypatch.setattr(server_audit.queue, "cancel_all", fake_audit_cancel)

    # Must NOT raise despite the crack queue blowing up mid-killswitch.
    line = asyncio.run(EngagementMode().killswitch())

    assert calls["runner"] == 1
    assert calls["audit"] == 1  # audit still cancelled despite the crack failure
    assert line["crack_jobs_cancelled"] == 0  # failed guard -> stayed 0
    assert line["audit_jobs_cancelled"] == 5


# --------------------------------------------------------------------------- #
# ScopeAllowlist.matches — CIDR-vs-CIDR containment fix.
#
# The bug: a CIDR *target* (e.g. an in-scope /23) only matched a scope CIDR by
# EXACT string, so a /23 fully inside a /22 scope was wrongly refused. The fix
# adds an ipaddress subnet_of() branch while preserving IP-in-CIDR + exact-host.
# --------------------------------------------------------------------------- #
def test_scope_subnet_in_wider_cidr_is_allowed():
    from warlock.engagement import ScopeAllowlist

    scope = ScopeAllowlist(ip_ranges=["10.0.0.0/22"])
    # 10.0.2.0/23 (10.0.2.0–10.0.3.255) is fully inside 10.0.0.0/22.
    assert scope.matches("10.0.2.0/23") is True
    # A network is a subnet of itself.
    assert ScopeAllowlist(ip_ranges=["10.0.0.0/23"]).matches("10.0.0.0/23") is True


def test_scope_wider_subnet_is_denied():
    from warlock.engagement import ScopeAllowlist

    scope = ScopeAllowlist(ip_ranges=["10.0.0.0/24"])
    # A /23 is BIGGER than the /24 scope -> not contained -> denied.
    assert scope.matches("10.0.0.0/23") is False
    # A sibling /24 outside the scope is also denied.
    assert scope.matches("10.0.1.0/24") is False


def test_scope_host_in_cidr_still_matches():
    from warlock.engagement import ScopeAllowlist

    scope = ScopeAllowlist(ip_ranges=["192.168.1.0/24"])
    assert scope.matches("192.168.1.50") is True   # bare IP inside the CIDR
    assert scope.matches("10.0.0.1") is False        # bare IP outside all CIDRs


def test_scope_ssid_bssid_and_exact_string_still_match():
    from warlock.engagement import ScopeAllowlist

    scope = ScopeAllowlist(
        ssids=["CorpWiFi"], bssids=["AA:BB:CC:DD:EE:FF"], ip_ranges=["lab-net"]
    )
    assert scope.matches("corpwifi") is True            # case-insensitive SSID
    assert scope.matches("aa:bb:cc:dd:ee:ff") is True   # BSSID
    assert scope.matches("lab-net") is True             # non-IP exact-string range
    assert scope.matches("") is False                    # empty target never matches


def test_scope_mixed_ip_version_does_not_crash():
    from warlock.engagement import ScopeAllowlist

    # subnet_of() raises TypeError across IP versions; the version guard must
    # skip the comparison (not crash) and fall through to a clean deny.
    scope = ScopeAllowlist(ip_ranges=["10.0.0.0/22"])
    assert scope.matches("2001:db8::/48") is False
