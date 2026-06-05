"""Unit tests for the managed crack queue (warlock.modules.crack).

No real hashcat ever runs: ``crack._spawn`` is mocked with a FakeProc that
replays a hashcat ``--status-json`` snapshot and writes the recovered plaintext
to the ``-o`` outfile parsed out of the argv. Two layers are proven:

  * the engagement GATE — refuses (403 + scope.violation audit row) when
    engagement is OFF or the target is out of scope, exactly like the inline
    wifi_offensive /crack op;
  * the QUEUE lifecycle — submit -> running -> cracked/exhausted/cancelled, with
    progress + the cracked passphrase surfaced — driven directly via asyncio so
    background-task progress is asserted deterministically (no TestClient races).
"""
from __future__ import annotations

import os
import tempfile

# Bind a throwaway data dir + disable basic-auth BEFORE any warlock import so the
# SQLite engine (bound at warlock.db import time) never touches the real DB.
os.environ["WARLOCK_DATA"] = tempfile.mkdtemp(prefix="warlock-crack-")
os.environ["WARLOCK_WEB_PASSWORD"] = ""

import asyncio  # noqa: E402
import json  # noqa: E402
from datetime import datetime  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

IN_SCOPE = "aa:bb:cc:dd:ee:ff"
OUT_SCOPE = "11:22:33:44:55:66"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
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


def _engage(bssids=None, ssids=None) -> None:
    from warlock.engagement import ScopeAllowlist, engagement

    engagement._mode = "on"
    engagement.engagement_id = "test-eng"
    engagement.name = "test"
    engagement.scope = ScopeAllowlist(bssids=bssids or [], ssids=ssids or [])
    engagement.started_at = datetime.utcnow()
    engagement.audit_log_path = None  # DB AuditEntry only; no yaml file in tests


def _count(kind: str, target: str) -> int:
    from warlock.db import session_scope
    from warlock.models import AuditEntry

    with session_scope() as s:
        return (
            s.query(AuditEntry)
            .filter(AuditEntry.kind == kind, AuditEntry.target == target)
            .count()
        )


def _make_hashfile(name: str = "cap.hc22000") -> Path:
    from warlock.config import get_settings

    cap = get_settings().data / "captures" / "wifi"
    cap.mkdir(parents=True, exist_ok=True)
    hf = cap / name
    hf.write_text("WPA*02*dummy*hashline\n")
    return hf


def _make_wordlist() -> Path:
    from warlock.config import get_settings

    wl = get_settings().data / "wordlists"
    wl.mkdir(parents=True, exist_ok=True)
    p = wl / "rockyou.txt"
    p.write_text("password\nhunter2\n")
    return p


def _make_capture(name: str = "handshake.cap") -> Path:
    """A raw airodump-style capture under captures/wifi (bytes, not a hashline)."""
    from warlock.config import get_settings

    cap = get_settings().data / "captures" / "wifi"
    cap.mkdir(parents=True, exist_ok=True)
    p = cap / name
    p.write_bytes(b"\xd4\xc3\xb2\xa1 fake pcap bytes")
    return p


# --------------------------------------------------------------------------- #
# Fake subprocesses — no real hashcat.
# --------------------------------------------------------------------------- #
class _FakeStdout:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        if not self._lines:
            raise StopAsyncIteration
        return self._lines.pop(0)


class FakeProc:
    """Minimal asyncio.subprocess.Process stand-in.

    On ``wait()`` it materialises the recovered plaintext into the ``-o`` outfile
    parsed from *argv* (when ``crack=True``), mirroring hashcat's behaviour with
    ``--outfile-format 2``.
    """

    def __init__(self, argv, *, status_obj, rc, crack, secret) -> None:
        self.argv = argv
        self.returncode = None
        self._rc = rc
        self._crack = crack
        self._secret = secret
        line = (json.dumps(status_obj) + "\n").encode("utf-8")
        self.stdout = _FakeStdout([b"hashcat: starting\n", line])

    async def wait(self) -> int:
        if self._crack:
            try:
                out = self.argv[self.argv.index("-o") + 1]
                Path(out).parent.mkdir(parents=True, exist_ok=True)
                Path(out).write_text(self._secret + "\n")
            except (ValueError, IndexError, OSError):
                pass
        self.returncode = self._rc
        return self._rc

    def terminate(self) -> None:
        self.returncode = -15


class _NeverProc:
    """A proc that yields no output and blocks on wait() until cancelled."""

    returncode = None
    stdout = None

    async def wait(self) -> int:
        await asyncio.sleep(30)
        return 0

    def terminate(self) -> None:
        self.returncode = -15


def _install_fake_spawn(monkeypatch, *, rc, crack, secret="hunter2", status_obj=None):
    import warlock.modules.crack as crack_mod

    obj = status_obj or {
        "status": 6 if crack else 5,
        "progress": [14344, 14344] if crack else [9000, 14344],
        "recovered_total": [1, 1] if crack else [0, 1],
        "devices": [{"speed": 123456}],
    }

    async def fake_spawn(argv):
        return FakeProc(argv, status_obj=obj, rc=rc, crack=crack, secret=secret)

    monkeypatch.setattr(crack_mod, "_spawn", fake_spawn)


class FakeConvertProc:
    """hcxpcapngtool stand-in. When ``produce`` is True it writes a non-empty
    .hc22000 hashline to the ``-o`` outfile (a usable handshake was present);
    when False it writes nothing (no crackable handshake in the capture)."""

    def __init__(self, argv, *, produce, rc) -> None:
        self.argv = argv
        self.returncode = None
        self._produce = produce
        self._rc = rc
        self.stdout = _FakeStdout([b"hcxpcapngtool 6.x reading capture\n"])

    async def wait(self) -> int:
        if self._produce:
            try:
                out = self.argv[self.argv.index("-o") + 1]
                Path(out).parent.mkdir(parents=True, exist_ok=True)
                Path(out).write_text("WPA*02*converted*from*capture\n")
            except (ValueError, IndexError, OSError):
                pass
        self.returncode = self._rc
        return self._rc

    def terminate(self) -> None:
        self.returncode = -15


def _install_convert_spawn(monkeypatch, *, produce, crack_rc=0, secret="hunter2"):
    """Dispatch _spawn by tool: hcxpcapngtool -> FakeConvertProc (optionally
    producing a hashfile), hashcat -> the cracking FakeProc. ``crack_spawned``
    (a list) records every hashcat argv so a test can assert it never ran."""
    import warlock.modules.crack as crack_mod

    crack_obj = {
        "status": 6,
        "progress": [14344, 14344],
        "recovered_total": [1, 1],
        "devices": [{"speed": 123456}],
    }
    crack_spawned: list[list[str]] = []

    async def fake_spawn(argv):
        if argv and argv[0].endswith("hcxpcapngtool"):
            return FakeConvertProc(argv, produce=produce, rc=0 if produce else 1)
        crack_spawned.append(argv)
        return FakeProc(argv, status_obj=crack_obj, rc=crack_rc, crack=True, secret=secret)

    monkeypatch.setattr(crack_mod, "_spawn", fake_spawn)
    return crack_spawned


# --------------------------------------------------------------------------- #
# Registration + status
# --------------------------------------------------------------------------- #
def test_module_registers(client):
    r = client.get("/api/modules")
    assert r.status_code == 200
    mods = {m["id"]: m for m in r.json()}
    assert "crack" in mods
    assert mods["crack"]["requires_engagement"] is True
    assert mods["crack"]["requires_root"] is False


def test_status_exposes_queue_and_inventory(client):
    r = client.get("/api/crack/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["modes"] == ["16800", "22000"]
    assert "counts" in body and "hashfiles" in body and "wordlists" in body
    assert body["requires_engagement"] is True


# --------------------------------------------------------------------------- #
# hashcat argv builder — offline (no sudo), correct mode + live-progress flags
# --------------------------------------------------------------------------- #
def test_crack_argv_no_root_and_status_flags(tmp_path):
    from warlock.modules.crack import _crack_argv

    argv = _crack_argv(
        hashfile=tmp_path / "x.hc22000", wordlist=tmp_path / "rockyou.txt",
        potfile=tmp_path / "p.pot", outfile=tmp_path / "o.cracked", session="crack-ab",
    )
    assert "sudo" not in argv  # offline cracking never needs root
    assert argv[0].endswith("hashcat")
    assert argv[argv.index("-m") + 1] == "22000"
    assert argv[argv.index("-a") + 1] == "0"
    assert str(tmp_path / "x.hc22000") in argv
    assert str(tmp_path / "rockyou.txt") in argv
    # live-progress + clean-readback flags the managed queue depends on
    assert "--status" in argv and "--status-json" in argv
    assert argv[argv.index("--status-timer") + 1] == "5"
    assert argv[argv.index("--outfile-format") + 1] == "2"
    assert argv[argv.index("--potfile-path") + 1] == str(tmp_path / "p.pot")
    assert "--restore-disable" in argv


def test_crack_argv_honours_mode():
    from warlock.modules.crack import _crack_argv

    argv = _crack_argv(hashfile=Path("/a.hc22000"), wordlist=Path("/w.txt"), mode="16800")
    assert argv[argv.index("-m") + 1] == "16800"


# --------------------------------------------------------------------------- #
# hcxpcapngtool argv builder — extracts .hc22000 from a raw capture, no root
# --------------------------------------------------------------------------- #
def test_hcxpcapng_argv_builder(tmp_path):
    from warlock.modules.crack import _hcxpcapng_argv

    argv = _hcxpcapng_argv(capture=tmp_path / "h.cap", out=tmp_path / "h.hc22000")
    assert argv[0].endswith("hcxpcapngtool")
    assert argv[argv.index("-o") + 1] == str(tmp_path / "h.hc22000")  # converted out
    assert str(tmp_path / "h.cap") in argv                            # capture input
    assert "sudo" not in argv  # offline conversion never needs root


def test_is_capture_recognises_capture_extensions():
    from warlock.modules.crack import _is_capture

    assert _is_capture(Path("/x/handshake.cap")) is True
    assert _is_capture(Path("/x/dump.PCAP")) is True   # case-insensitive
    assert _is_capture(Path("/x/dump.pcapng")) is True
    assert _is_capture(Path("/x/ready.hc22000")) is False


# --------------------------------------------------------------------------- #
# GATE: refuse via the HTTP API when engagement is OFF / out of scope
# --------------------------------------------------------------------------- #
def test_submit_refuses_when_engagement_off(client):
    _make_hashfile()
    _make_wordlist()
    before = _count("scope.violation", IN_SCOPE)
    r = client.post("/api/crack/jobs", json={"hashfile": "cap.hc22000", "target": IN_SCOPE})
    assert r.status_code == 403
    # refusal is persisted as a scope.violation audit row (mirrors the inline op)
    assert _count("scope.violation", IN_SCOPE) == before + 1


def test_submit_rejects_out_of_scope_target(client):
    _make_hashfile()
    _make_wordlist()
    _engage(bssids=[IN_SCOPE])
    before = _count("scope.violation", OUT_SCOPE)
    r = client.post("/api/crack/jobs", json={"hashfile": "cap.hc22000", "target": OUT_SCOPE})
    assert r.status_code == 403
    assert _count("scope.violation", OUT_SCOPE) == before + 1


def test_submit_rejects_bad_mode_before_gate(client):
    r = client.post("/api/crack/jobs", json={"hashfile": "cap.hc22000", "mode": "9999"})
    assert r.status_code == 400


def test_submit_rejects_path_traversal(client):
    _engage(bssids=[IN_SCOPE])
    r = client.post("/api/crack/jobs", json={"hashfile": "/etc/shadow", "target": IN_SCOPE})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# HTTP happy path: submit accepted, shows up in the list, writes a job.submit row
# --------------------------------------------------------------------------- #
def test_submit_accepted_lists_and_audits(client, monkeypatch):
    _make_hashfile()
    _make_wordlist()
    _engage(bssids=[IN_SCOPE])
    _install_fake_spawn(monkeypatch, rc=0, crack=True, secret="hunter2")
    before = _count("job.submit", IN_SCOPE)

    r = client.post("/api/crack/jobs", json={"hashfile": "cap.hc22000", "target": IN_SCOPE})
    assert r.status_code == 200, r.text
    body = r.json()
    job_id = body["job_id"]
    assert body["job"]["target"] == IN_SCOPE
    assert body["job"]["mode"] == "22000"
    # every accepted job is audited
    assert _count("job.submit", IN_SCOPE) == before + 1

    # appears in the list + is fetchable by id
    lst = client.get("/api/crack/jobs").json()
    assert any(j["id"] == job_id for j in lst["jobs"])
    one = client.get(f"/api/crack/jobs/{job_id}")
    assert one.status_code == 200
    assert one.json()["job"]["id"] == job_id


def test_get_unknown_job_is_404(client):
    r = client.get("/api/crack/jobs/does-not-exist")
    assert r.status_code == 404


def test_submit_capture_routes_through_conversion(client, monkeypatch):
    """The LOOT entry point (POST /api/crack/jobs with a .cap) resolves the raw
    capture and routes it through conversion — the job's crack input is a .hc22000."""
    _make_capture("loot.cap")
    _make_wordlist()
    _engage(bssids=[IN_SCOPE])
    _install_convert_spawn(monkeypatch, produce=True)

    r = client.post("/api/crack/jobs", json={"hashfile": "loot.cap", "target": IN_SCOPE})
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    assert job["converted"] is True
    assert job["hashfile_name"] == "loot.cap"          # submitted the raw capture
    assert job["crack_input_name"].endswith(".hc22000")  # hashcat reads the converted file


# --------------------------------------------------------------------------- #
# QUEUE lifecycle — driven directly via asyncio for deterministic assertions.
# --------------------------------------------------------------------------- #
def test_lifecycle_cracked(monkeypatch):
    """submit -> run -> CRACKED, surfacing progress + the recovered passphrase."""
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    hf = _make_hashfile("life.hc22000")
    wl = _make_wordlist()
    _install_fake_spawn(monkeypatch, rc=0, crack=True, secret="hunter2")

    async def scenario():
        q = crack_mod.CrackQueue()
        job = await q.submit(hashfile=hf, wordlist=wl, mode="22000", target=IN_SCOPE, note="t")
        assert job.status in ("queued", "running")
        await job.task  # drive to completion
        return job

    job = asyncio.run(scenario())
    assert job.status == "cracked"
    assert job.cracked == "hunter2"
    assert job.progress == 100.0
    assert job.recovered == "1/1"
    assert job.speed_hs == 123456
    assert job.finished_at is not None


def test_lifecycle_exhausted(monkeypatch):
    """rc=1 with no outfile content -> EXHAUSTED (no passphrase)."""
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    hf = _make_hashfile("ex.hc22000")
    wl = _make_wordlist()
    _install_fake_spawn(monkeypatch, rc=1, crack=False)

    async def scenario():
        q = crack_mod.CrackQueue()
        job = await q.submit(hashfile=hf, wordlist=wl, mode="22000", target=IN_SCOPE, note="t")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.status == "exhausted"
    assert job.cracked is None
    assert job.progress == 100.0


def test_lifecycle_cancel_queued_job(monkeypatch):
    """A second job stays queued behind the single slot, then cancels cleanly."""
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    hf = _make_hashfile("can.hc22000")
    wl = _make_wordlist()

    async def scenario():
        q = crack_mod.CrackQueue(concurrency=1)
        a_running = asyncio.Event()

        async def slow_spawn(argv):
            a_running.set()
            return _NeverProc()

        monkeypatch.setattr(crack_mod, "_spawn", slow_spawn)
        a = await q.submit(hashfile=hf, wordlist=wl, mode="22000", target=IN_SCOPE, note="A")
        await a_running.wait()                # A holds the only slot (running)
        b = await q.submit(hashfile=hf, wordlist=wl, mode="22000", target=IN_SCOPE, note="B")
        assert b.status == "queued"           # B is waiting behind A
        assert await q.cancel(b.id) is True
        await q.cancel(a.id)                  # tidy A so the loop can drain
        await asyncio.gather(a.task, b.task, return_exceptions=True)
        return b

    job = asyncio.run(scenario())
    assert job.status == "cancelled"
    assert job.cracked is None


def test_cancel_all_clears_active(monkeypatch):
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    hf = _make_hashfile("all.hc22000")
    wl = _make_wordlist()

    async def scenario():
        q = crack_mod.CrackQueue()

        async def slow_spawn(argv):
            return _NeverProc()

        monkeypatch.setattr(crack_mod, "_spawn", slow_spawn)
        job = await q.submit(hashfile=hf, wordlist=wl, mode="22000", target=IN_SCOPE, note="A")
        await asyncio.sleep(0)
        n = await q.cancel_all()
        await asyncio.gather(job.task, return_exceptions=True)
        return n

    n = asyncio.run(scenario())
    assert n >= 1


# --------------------------------------------------------------------------- #
# /hashfiles lists raw captures alongside .hc22000, each tagged with its type
# --------------------------------------------------------------------------- #
def test_hashfiles_lists_captures_with_type_tags(client):
    _make_hashfile("ready.hc22000")
    _make_capture("listed.cap")
    _make_capture("listed.pcapng")
    r = client.get("/api/crack/hashfiles")
    assert r.status_code == 200
    by_name = {f["filename"]: f for f in r.json()["hashfiles"]}

    assert "ready.hc22000" in by_name
    assert by_name["ready.hc22000"]["type"] == "hc22000"
    assert by_name["ready.hc22000"]["is_capture"] is False

    assert "listed.cap" in by_name
    assert by_name["listed.cap"]["type"] == "cap"
    assert by_name["listed.cap"]["is_capture"] is True

    assert "listed.pcapng" in by_name
    assert by_name["listed.pcapng"]["type"] == "pcapng"
    assert by_name["listed.pcapng"]["is_capture"] is True


# --------------------------------------------------------------------------- #
# Convert-then-crack — a raw .cap is converted via hcxpcapngtool, then cracked.
# --------------------------------------------------------------------------- #
def test_convert_then_crack(monkeypatch):
    """submit a .cap -> CONVERT (hcxpcapngtool) -> CRACK -> cracked passphrase."""
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    cap = _make_capture("good.cap")
    wl = _make_wordlist()
    crack_spawned = _install_convert_spawn(monkeypatch, produce=True, secret="hunter2")

    async def scenario():
        q = crack_mod.CrackQueue()
        job = await q.submit(hashfile=cap, wordlist=wl, mode="22000", target=IN_SCOPE, note="t")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.status == "cracked"
    assert job.cracked == "hunter2"
    assert job.progress == 100.0
    # the job cracked a CONVERTED .hc22000, not the raw capture it was submitted with
    assert job.converted is True
    assert job.hashfile == str(cap)
    assert job.crack_input.endswith(".hc22000")
    assert job.crack_input != job.hashfile
    # the converted file actually landed under captures/wifi/cracked/
    assert Path(job.crack_input).exists()
    assert "cracked" in Path(job.crack_input).parts
    # the crack subprocess ran against the converted file
    assert crack_spawned and str(job.crack_input) in crack_spawned[0]
    # conversion is surfaced as a step in the job log
    assert any("[convert]" in line for line in job.tail)


def test_convert_no_handshake_fails_cleanly(monkeypatch):
    """A capture with no usable handshake -> CLEAN fail, hashcat never spawns."""
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    cap = _make_capture("empty.cap")
    wl = _make_wordlist()
    crack_spawned = _install_convert_spawn(monkeypatch, produce=False)

    async def scenario():
        q = crack_mod.CrackQueue()
        job = await q.submit(hashfile=cap, wordlist=wl, mode="22000", target=IN_SCOPE, note="t")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.status == "failed"
    assert job.reason == "no crackable handshake/PMKID in capture"
    assert job.cracked is None
    # short-circuit proven: hashcat was never spawned for the unconvertible capture
    assert crack_spawned == []
    # no empty .hc22000 was left behind as a usable crack input
    assert not Path(job.crack_input).exists()
    assert job.finished_at is not None


def test_direct_hc22000_skips_conversion(monkeypatch):
    """A direct .hc22000 submission is cracked as-is — no conversion step."""
    from warlock.modules import crack as crack_mod

    _engage(bssids=[IN_SCOPE])
    hf = _make_hashfile("direct.hc22000")
    wl = _make_wordlist()
    crack_spawned = _install_convert_spawn(monkeypatch, produce=False)  # would fail IF converted

    async def scenario():
        q = crack_mod.CrackQueue()
        job = await q.submit(hashfile=hf, wordlist=wl, mode="22000", target=IN_SCOPE, note="t")
        await job.task
        return job

    job = asyncio.run(scenario())
    assert job.converted is False
    assert job.crack_input == str(hf)
    assert job.status == "cracked"        # cracked directly, no conversion gate
    assert crack_spawned and str(hf) in crack_spawned[0]
    assert not any("[convert]" in line for line in job.tail)
