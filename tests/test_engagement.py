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
