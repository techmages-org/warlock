"""Tests for the engagement auto-expiry watchdog.

Verifies:
  - planned_end is set when activating with duration_hours
  - remaining_s counts down correctly
  - is_expired() returns True after planned_end
  - status() includes planned_end and remaining_s fields
  - end() clears planned_end
  - The expiry loop calls end() when expired
"""
import asyncio
import os
from datetime import datetime, timedelta

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest


@pytest.fixture(autouse=True)
def _reset_engagement():
    """Ensure engagement is off before and after each test."""
    from warlock.engagement import engagement

    async def _end():
        if engagement.is_on():
            await engagement.end()

    asyncio.run(_end())
    yield
    asyncio.run(_end())


def test_planned_end_set_on_activate():
    """Activating with planned_end stores it."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])
    planned = datetime.utcnow() + timedelta(hours=4)

    async def _activate():
        await engagement.activate(
            name="test-expiry",
            auth_statement="lab test environment",
            scope=scope,
            planned_end=planned,
        )

    asyncio.run(_activate())
    assert engagement.is_on()
    assert engagement.planned_end is not None
    delta = abs((engagement.planned_end - planned).total_seconds())
    assert delta < 2


def test_remaining_s_in_status():
    """status() returns remaining_s counting down from planned_end."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])
    planned = datetime.utcnow() + timedelta(hours=1)

    async def _activate():
        await engagement.activate(
            name="test-remaining",
            auth_statement="lab test",
            scope=scope,
            planned_end=planned,
        )

    asyncio.run(_activate())
    st = engagement.status()
    assert st["remaining_s"] is not None
    assert 3500 < st["remaining_s"] < 3700


def test_remaining_s_negative_after_expiry():
    """remaining_s goes negative after planned_end passes."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])
    planned = datetime.utcnow() - timedelta(seconds=1)

    async def _activate():
        await engagement.activate(
            name="test-past",
            auth_statement="lab test",
            scope=scope,
            planned_end=planned,
        )

    asyncio.run(_activate())
    st = engagement.status()
    assert st["remaining_s"] is not None
    assert st["remaining_s"] < 0


def test_is_expired_true_after_planned_end():
    """is_expired() returns True when planned_end has passed."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])

    async def _activate():
        await engagement.activate(
            name="test-expired",
            auth_statement="lab test",
            scope=scope,
            planned_end=datetime.utcnow() - timedelta(minutes=5),
        )

    asyncio.run(_activate())
    assert engagement.is_expired() is True


def test_is_expired_false_when_no_planned_end():
    """is_expired() returns False when there's no planned_end."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])

    async def _activate():
        await engagement.activate(
            name="test-no-end",
            auth_statement="lab test",
            scope=scope,
        )

    asyncio.run(_activate())
    assert engagement.planned_end is None
    assert engagement.is_expired() is False


def test_is_expired_false_when_not_expired():
    """is_expired() returns False when planned_end is in the future."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])

    async def _activate():
        await engagement.activate(
            name="test-future",
            auth_statement="lab test",
            scope=scope,
            planned_end=datetime.utcnow() + timedelta(hours=2),
        )

    asyncio.run(_activate())
    assert engagement.is_expired() is False


def test_end_clears_planned_end():
    """end() should reset planned_end to None."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])

    async def _setup():
        await engagement.activate(
            name="test-clear",
            auth_statement="lab test",
            scope=scope,
            planned_end=datetime.utcnow() + timedelta(hours=4),
        )

    asyncio.run(_setup())
    assert engagement.planned_end is not None

    asyncio.run(engagement.end())
    assert engagement.planned_end is None
    assert not engagement.is_on()


def test_expiry_logic_ends_engagement():
    """Simulate the auto-expiry watchdog: when is_expired() is True,
    the engagement should be ended."""
    from warlock.engagement import engagement, ScopeAllowlist

    scope = ScopeAllowlist(ssids=["TestWiFi"])

    async def _setup():
        await engagement.activate(
            name="test-loop",
            auth_statement="lab test",
            scope=scope,
            planned_end=datetime.utcnow() - timedelta(minutes=1),
        )

    asyncio.run(_setup())
    assert engagement.is_on()

    async def _watchdog_step():
        if engagement.is_expired():
            await engagement.end()

    asyncio.run(_watchdog_step())
    assert not engagement.is_on()
