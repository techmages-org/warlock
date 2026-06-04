"""Unit tests for the wifi_recon spin-guard.

These prove airodump-ng can never be left spinning a CPU core when its capture
interface vanishes or its capture output stalls (the MT7921 re-enumeration /
monitor-cycle thermal-runaway failure mode):

  * pre-launch: /start refuses (and restores managed) when mon0 isn't up, instead
    of spawning a spinner;
  * watchdog: kills airodump + backs off when the iface disappears OR output
    stops growing for the stall window;
  * healthy path: when the iface is up and output advances, nothing is killed and
    the watchdog is launched as normal.

No real airodump-ng / helper subprocess is ever spawned — all process spawning
(`subprocess.Popen`, `asyncio.create_subprocess_exec`) is mocked.
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-wifirecon-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

import asyncio  # noqa: E402
import sys  # noqa: E402
from unittest.mock import AsyncMock, Mock  # noqa: E402

import pytest  # noqa: E402

import warlock.modules.wifi_recon as wr  # noqa: E402


class _FakeProc:
    """Stand-in for an asyncio subprocess (helper monitor/managed calls)."""

    returncode = 0

    async def communicate(self):
        return (b"", b"")


# --------------------------------------------------------------------------- #
# interface-readiness helpers
# --------------------------------------------------------------------------- #
def test_iface_ready_states(tmp_path, monkeypatch):
    net = tmp_path / "net"
    net.mkdir()
    monkeypatch.setattr(wr, "_SYS_CLASS_NET", net)

    # Missing interface -> not ready.
    assert not wr._iface_exists("mon0")
    assert not wr._iface_ready("mon0")

    # Present but down (IFF_UP bit clear) -> not ready.
    mon = net / "mon0"
    mon.mkdir()
    (mon / "flags").write_text("0x1002\n")
    assert wr._iface_exists("mon0")
    assert not wr._iface_is_up("mon0")
    assert not wr._iface_ready("mon0")

    # Up (IFF_UP bit set) -> ready.
    (mon / "flags").write_text("0x1003\n")
    assert wr._iface_is_up("mon0")
    assert wr._iface_ready("mon0")

    # Garbage flags -> treated as down, never raises.
    (mon / "flags").write_text("not-hex\n")
    assert not wr._iface_is_up("mon0")


def test_output_mtime(tmp_path):
    prefix = tmp_path / "airodump-20260604"
    assert wr._output_mtime(prefix) == 0.0  # nothing written yet

    csv1 = tmp_path / "airodump-20260604-01.csv"
    csv1.write_text("x")
    os.utime(csv1, (1000.0, 1000.0))
    pcap = tmp_path / "airodump-20260604-01.pcap"
    pcap.write_text("y")
    os.utime(pcap, (2500.0, 2500.0))
    # Unrelated prefix must not count.
    other = tmp_path / "airodump-OTHER-01.csv"
    other.write_text("z")
    os.utime(other, (9999.0, 9999.0))

    assert wr._output_mtime(prefix) == 2500.0


# --------------------------------------------------------------------------- #
# pre-launch guard
# --------------------------------------------------------------------------- #
def test_start_refuses_when_iface_not_ready(tmp_path, monkeypatch):
    net = tmp_path / "net"
    net.mkdir()  # mon0 absent -> not ready
    monkeypatch.setattr(wr, "_SYS_CLASS_NET", net)
    monkeypatch.setattr(wr, "AIRODUMP", sys.executable)  # passes the "exists" check
    monkeypatch.setattr(wr, "_is_running", lambda: False)

    helper = AsyncMock(return_value=_FakeProc())  # monitor + managed-cleanup calls
    monkeypatch.setattr(wr.asyncio, "create_subprocess_exec", helper)
    popen = Mock(side_effect=AssertionError("airodump-ng must NOT be spawned"))
    monkeypatch.setattr(wr.subprocess, "Popen", popen)

    with pytest.raises(wr.HTTPException) as ei:
        asyncio.run(wr._start_airodump("all", None))

    assert ei.value.status_code == 500
    assert "refusing to launch" in ei.value.detail
    popen.assert_not_called()
    # Helper was invoked at least for the managed-restore cleanup.
    assert helper.await_count >= 1


def test_start_launches_watchdog_when_iface_ready(tmp_path, monkeypatch):
    net = tmp_path / "net"
    mon = net / "mon0"
    mon.mkdir(parents=True)
    (mon / "flags").write_text("0x1003\n")  # up
    monkeypatch.setattr(wr, "_SYS_CLASS_NET", net)
    monkeypatch.setattr(wr, "AIRODUMP", sys.executable)
    monkeypatch.setattr(wr, "_is_running", lambda: False)
    monkeypatch.setattr(wr, "PID_PATH", tmp_path / "airodump.pid")
    monkeypatch.setattr(wr, "STATE_PATH", tmp_path / "airodump.state")

    helper = AsyncMock(return_value=_FakeProc())
    monkeypatch.setattr(wr.asyncio, "create_subprocess_exec", helper)
    fake_proc = Mock()
    fake_proc.pid = 4321
    popen = Mock(return_value=fake_proc)
    monkeypatch.setattr(wr.subprocess, "Popen", popen)

    launched: dict[str, object] = {}
    monkeypatch.setattr(
        wr, "_launch_watchdog", lambda prefix, iface: launched.update(prefix=prefix, iface=iface)
    )

    state = asyncio.run(wr._start_airodump("all", None))

    popen.assert_called_once()
    assert state["pid"] == 4321
    assert launched.get("iface") == "mon0"  # watchdog armed on the healthy path


# --------------------------------------------------------------------------- #
# watchdog
# --------------------------------------------------------------------------- #
def test_watchdog_kills_on_vanished_iface(tmp_path, monkeypatch):
    teardown = AsyncMock()
    monkeypatch.setattr(wr, "_is_running", lambda: True)
    monkeypatch.setattr(wr, "_iface_ready", lambda iface: False)  # vanished/down
    monkeypatch.setattr(wr, "_output_mtime", lambda prefix: 100.0)
    monkeypatch.setattr(wr, "_teardown_airodump", teardown)

    asyncio.run(
        wr._watchdog(tmp_path / "airodump-x", "mon0", poll_s=0.01, stall_s=10.0)
    )

    teardown.assert_awaited_once()
    assert wr._last_stop_reason is not None
    assert "vanished" in wr._last_stop_reason


def test_watchdog_kills_on_output_stall(tmp_path, monkeypatch):
    teardown = AsyncMock()
    monkeypatch.setattr(wr, "_is_running", lambda: True)
    monkeypatch.setattr(wr, "_iface_ready", lambda iface: True)  # iface fine...
    monkeypatch.setattr(wr, "_output_mtime", lambda prefix: 100.0)  # ...but output frozen
    monkeypatch.setattr(wr, "_teardown_airodump", teardown)

    asyncio.run(
        wr._watchdog(tmp_path / "airodump-x", "mon0", poll_s=0.01, stall_s=0.05)
    )

    teardown.assert_awaited_once()
    assert "stalled" in (wr._last_stop_reason or "")


def test_watchdog_leaves_healthy_capture_alone(tmp_path, monkeypatch):
    teardown = AsyncMock()
    # Exit the loop after a few healthy iterations via _is_running going False.
    monkeypatch.setattr(wr, "_is_running", Mock(side_effect=[True, True, True, False]))
    monkeypatch.setattr(wr, "_iface_ready", lambda iface: True)
    counter = {"v": 100.0}

    def advancing(prefix):
        counter["v"] += 1.0  # output keeps growing -> never stalls
        return counter["v"]

    monkeypatch.setattr(wr, "_output_mtime", advancing)
    monkeypatch.setattr(wr, "_teardown_airodump", teardown)

    asyncio.run(
        wr._watchdog(tmp_path / "airodump-x", "mon0", poll_s=0.01, stall_s=0.05)
    )

    teardown.assert_not_awaited()  # healthy path: airodump is never killed
