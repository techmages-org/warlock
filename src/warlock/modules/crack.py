"""Crack queue — a managed, first-class queue of async hashcat jobs.

Offline WPA/WPA2 cracking over captured ``.hc22000`` hashfiles + the seeded
wordlists. This is a SEPARATE, managed queue — distinct from the one-shot inline
``/api/wifi_offensive/crack`` op (which fires a single job through the shared
``warlock.jobs.runner``). The runner only captures stdout at process exit, so it
cannot surface *live* progress; this module manages its own subprocesses to parse
hashcat's ``--status-json`` snapshots and expose status / progress / the cracked
passphrase as each job runs.

  POST   /api/crack/jobs              submit {hashfile, mode, wordlist?, target?}
  GET    /api/crack/jobs              list every job + status/progress
  GET    /api/crack/jobs/{id}         one job (incl. recent output tail)
  POST   /api/crack/jobs/{id}/cancel  terminate a queued/running job
  GET    /api/crack/status            tool + queue summary, hashfiles, wordlists
  GET    /api/crack/hashfiles         capturable .hc22000 files (UI dropdown)
  GET    /api/crack/wordlists         seeded wordlists (UI dropdown)

GATING — mirrors the existing ``wifi_offensive`` ``/crack`` op EXACTLY. That op
submits through ``runner.submit(requires_engagement=True)``, so cracking requires
engagement mode to be ON and (when a target is given) that target to be inside
the engagement scope allowlist. We reproduce that gate here:

  * engagement OFF                -> HTTP 403 + a ``scope.violation`` audit row + alert
  * target given but out-of-scope -> HTTP 403 + a ``scope.violation`` audit row + alert
  * accepted                      -> a ``job.submit`` audit row (every job is audited)

Cracking is OFFLINE — no RF, no root (no ``sudo`` prefix, exactly like the inline
op) — so a job never touches the radio. The gate is purely an authorisation +
audit boundary. Everything is also behind the app's HTTP basic auth.

KILLSWITCH NOTE: ``engagement.killswitch()`` cancels in-flight work via
``runner.cancel_all()``, which only sees the *shared* runner's processes — NOT
this queue. ``Module.on_shutdown`` cancels in-flight crack jobs on a clean server
stop (fully in our control). Wiring ``killswitch -> queue.cancel_all()`` needs an
edit to ``engagement.py`` (owned by another module) and is tracked as a follow-up.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import shlex
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from warlock import events
from warlock.config import get_settings
from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import AuditEntry
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.crack")

# --- tool path + cracking conventions (mirrors wifi_offensive) ----------------
HASHCAT = shutil.which("hashcat") or "/usr/bin/hashcat"
HC22000_MODE = "22000"
CRACK_MODES = {"22000", "16800"}  # 22000 = WPA*-PBKDF2 PMKID+EAPOL, 16800 = legacy PMKID

DEFAULT_STATUS_TIMER = 5  # seconds between hashcat --status-json snapshots
MAX_JOBS = 200            # in-memory history cap (active jobs are never evicted)
TAIL_LINES = 30           # non-JSON output lines retained per job for debugging

_MAC_RE = re.compile(r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")

# hashcat --status-json `status` integer -> a coarse label we surface alongside
# our own queue state. (3=Running, 5=Exhausted, 6=Cracked, plus abort variants.)
_HC_STATUS_CRACKED = 6
_HC_STATUS_EXHAUSTED = 5


# --------------------------------------------------------------------------- #
# Data directories (under the operator data root, default ~/warlock) — same
# layout the wifi captures use, so this queue cracks what the offensive ops write.
# --------------------------------------------------------------------------- #
def _dir(*parts: str) -> Path:
    p = get_settings().data.joinpath(*parts)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _captures_dir() -> Path:
    return _dir("captures", "wifi")


def _handshakes_dir() -> Path:
    return _dir("handshakes")


def _wordlists_dir() -> Path:
    return _dir("wordlists")


def _cracked_dir() -> Path:
    """Where per-job hashcat ``-o`` outfiles land (recovered plaintext)."""
    return _dir("captures", "wifi", "cracked")


def _potfile() -> Path:
    return _captures_dir() / "crack.potfile"


# --------------------------------------------------------------------------- #
# Validation / path-safety helpers (mirror wifi_offensive._resolve_wordlist etc.)
# --------------------------------------------------------------------------- #
def _contained(path: Path, root: Path) -> bool:
    """True if *path* resolves inside *root* (blocks ../ traversal)."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _resolve_wordlist(name: str | None) -> Path:
    wdir = _wordlists_dir()
    if not name:
        for cand in ("rockyou.txt", "common-wpa-passwords.txt"):
            p = wdir / cand
            if p.exists():
                return p
        return wdir / "rockyou.txt"  # canonical default; existence checked at run time
    p = Path(name) if "/" in name else (wdir / name)
    if not _contained(p, wdir):
        raise HTTPException(400, f"wordlist must live under {wdir}")
    return p


def _resolve_hashfile(name: str) -> Path:
    """Resolve a submitted hashfile to a path under captures/ or handshakes/.

    Accepts a full path or a bare filename (searched in captures/wifi then
    handshakes). Rejects anything that escapes those two data dirs (traversal).
    """
    raw = (name or "").strip()
    if not raw:
        raise HTTPException(400, "hashfile is required")
    if "/" in raw:
        p = Path(raw)
    else:
        cand = _captures_dir() / raw
        p = cand if cand.exists() else (_handshakes_dir() / raw)
    if not (_contained(p, _captures_dir()) or _contained(p, _handshakes_dir())):
        raise HTTPException(400, "hashfile must live under the captures/ or handshakes/ data dirs")
    return p


def _norm_target(raw: str | None) -> str:
    """Lower-case a MAC-shaped target (scope matching is case-insensitive); pass
    any other (ESSID-style) target through unchanged."""
    v = (raw or "").strip()
    return v.lower() if _MAC_RE.match(v) else v


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Pure command builder — offline, NO sudo (cracking never needs root), exactly
# like wifi_offensive._crack_command. Adds the live-progress flags the managed
# queue depends on. Every interpolated value is a path or an int-coerced scalar.
# --------------------------------------------------------------------------- #
def _crack_argv(
    *,
    hashfile: Path,
    wordlist: Path,
    mode: str = HC22000_MODE,
    potfile: Path | None = None,
    outfile: Path | None = None,
    status_timer: int = DEFAULT_STATUS_TIMER,
    session: str | None = None,
) -> list[str]:
    """Build the hashcat invocation for a queued crack job.

    ``--status --status-json --status-timer N`` emit one compact JSON status
    snapshot per interval on stdout (parsed for %/speed/recovered). ``-o`` +
    ``--outfile-format 2`` make the outfile contain ONLY the recovered plaintext
    (trivial to read back as the cracked passphrase). ``--restore-disable`` stops
    the queue from littering restore files. No ``sudo`` — offline op, no root.
    """
    mode = str(mode)
    timer = max(1, int(status_timer))
    argv: list[str] = [
        HASHCAT,
        "-m", mode,
        "-a", "0",
        str(hashfile),
        str(wordlist),
        "-w", "3",
        "--status",
        "--status-json",
        "--status-timer", str(timer),
        "--restore-disable",
    ]
    if potfile is not None:
        argv += ["--potfile-path", str(potfile)]
    if outfile is not None:
        argv += ["-o", str(outfile), "--outfile-format", "2"]
    if session:
        argv += ["--session", session]
    return argv


def _read_outfile(path: str | Path) -> str | None:
    """Return the recovered plaintext from an ``--outfile-format 2`` outfile."""
    p = Path(path)
    try:
        if p.exists() and p.stat().st_size > 0:
            lines = [ln.strip() for ln in p.read_text("utf-8", errors="replace").splitlines() if ln.strip()]
            if lines:
                return lines[0] if len(lines) == 1 else " | ".join(lines)
    except OSError:
        pass
    return None


def _ingest_status_json(job: CrackJob, obj: dict[str, Any]) -> None:
    """Fold one hashcat ``--status-json`` snapshot into a job's live state."""
    prog = obj.get("progress")
    if isinstance(prog, list) and len(prog) == 2 and prog[1]:
        with contextlib.suppress(TypeError, ZeroDivisionError):
            job.progress = round(min(100.0, max(0.0, prog[0] / prog[1] * 100.0)), 2)
    rec = obj.get("recovered_total") or obj.get("recovered")
    if isinstance(rec, list) and len(rec) == 2:
        job.recovered = f"{rec[0]}/{rec[1]}"
    devs = obj.get("devices")
    if isinstance(devs, list):
        spd = 0
        for d in devs:
            try:
                spd += int(d.get("speed") or 0)
            except (TypeError, ValueError):
                continue
        job.speed_hs = spd
    st = obj.get("status")
    if isinstance(st, int):
        job.hc_status = st


# --------------------------------------------------------------------------- #
# Job model
# --------------------------------------------------------------------------- #
@dataclass
class CrackJob:
    id: str
    hashfile: str
    wordlist: str
    mode: str
    target: str
    note: str
    argv: list[str]
    outfile: str
    potfile: str
    status: str = "queued"  # queued|running|cracked|exhausted|failed|cancelled|error
    submitted_at: str = field(default_factory=_now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    progress: float = 0.0
    speed_hs: int = 0
    recovered: str | None = None
    cracked: str | None = None
    returncode: int | None = None
    error: str | None = None
    hc_status: int | None = None
    tail: list[str] = field(default_factory=list)
    # runtime-only handles (never serialised)
    task: asyncio.Task | None = field(default=None, repr=False, compare=False)
    proc: Any = field(default=None, repr=False, compare=False)
    cancelled: bool = field(default=False, repr=False, compare=False)

    @property
    def terminal(self) -> bool:
        return self.status in ("cracked", "exhausted", "failed", "cancelled", "error")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "hashfile": self.hashfile,
            "hashfile_name": Path(self.hashfile).name,
            "wordlist": self.wordlist,
            "wordlist_name": Path(self.wordlist).name,
            "mode": self.mode,
            "target": self.target,
            "note": self.note,
            "status": self.status,
            "progress": self.progress,
            "speed_hs": self.speed_hs,
            "recovered": self.recovered,
            "cracked": self.cracked,
            "returncode": self.returncode,
            "error": self.error,
            "submitted_at": self.submitted_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "argv": self.argv,
        }


# --------------------------------------------------------------------------- #
# Audit + gate (mirrors warlock.jobs.runner.submit's engagement gate exactly).
# --------------------------------------------------------------------------- #
def _audit(kind: str, command: str, target: str, note: str, outcome: str) -> None:
    with session_scope() as s:
        s.add(
            AuditEntry(
                engagement_id=engagement.engagement_id,
                kind=kind,
                command=command,
                sha256=_sha256(command),
                target=target,
                note=note,
                outcome=outcome,
            )
        )


async def _gate(command: str, target: str, note: str) -> None:
    """Authoritative engagement gate. Refusals raise HTTP 403 and persist a
    ``scope.violation`` audit row + an alert; accepted jobs get a ``job.submit``
    row. Identical semantics to ``runner.submit(requires_engagement=True)``."""
    if not engagement.is_on():
        _audit("scope.violation", command, target, f"engagement-off: {note}", "refused")
        await events.bus.publish(
            events.ALERT_FIRED,
            {"severity": "warning", "source": "engagement", "message": "scope violation: engagement-off"},
        )
        raise HTTPException(403, "engagement mode is OFF; refusing crack invocation")
    if target and not engagement.check_target(target):
        _audit("scope.violation", command, target, f"out-of-scope: {note}", "refused")
        await events.bus.publish(
            events.ALERT_FIRED,
            {"severity": "warning", "source": "engagement", "message": "scope violation: out-of-scope"},
        )
        raise HTTPException(403, f"target {target!r} is not in engagement scope allowlist")
    _audit("job.submit", command, target, note, "submitted")


# --------------------------------------------------------------------------- #
# Subprocess spawn — indirected through a module-level helper so tests can mock
# it (no real hashcat). Stderr is folded into stdout so the status-json stream
# and any tool errors arrive on one ordered pipe.
# --------------------------------------------------------------------------- #
async def _spawn(argv: list[str]) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
    )


# --------------------------------------------------------------------------- #
# The managed queue
# --------------------------------------------------------------------------- #
class CrackQueue:
    """In-memory queue of async hashcat jobs.

    Concurrency is capped by a semaphore (default 1 — the cracker is GPU-bound,
    so jobs run one-at-a-time and wait their turn in ``queued`` state). Job state
    lives in memory (the source of truth for the API); the engagement gate writes
    durable audit rows. A strong ref to each job's task is kept in the registry so
    it cannot be garbage-collected mid-run.
    """

    def __init__(self, concurrency: int = 1) -> None:
        self._jobs: dict[str, CrackJob] = {}
        self._order: list[str] = []
        self._sem = asyncio.Semaphore(max(1, concurrency))

    # --- reads ---
    def get(self, job_id: str) -> CrackJob | None:
        return self._jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        return [self._jobs[j].to_dict() for j in reversed(self._order) if j in self._jobs]

    def counts(self) -> dict[str, int]:
        c = {"queued": 0, "running": 0, "cracked": 0, "exhausted": 0, "failed": 0,
             "cancelled": 0, "error": 0, "total": 0}
        for j in self._jobs.values():
            c[j.status] = c.get(j.status, 0) + 1
            c["total"] += 1
        return c

    # --- submit ---
    async def submit(
        self,
        *,
        hashfile: Path,
        wordlist: Path,
        mode: str,
        target: str,
        note: str,
        status_timer: int = DEFAULT_STATUS_TIMER,
    ) -> CrackJob:
        job_id = str(uuid4())
        outfile = _cracked_dir() / f"{hashfile.stem}-{job_id[:8]}.cracked"
        potfile = _potfile()
        argv = _crack_argv(
            hashfile=hashfile, wordlist=wordlist, mode=mode,
            potfile=potfile, outfile=outfile,
            status_timer=status_timer, session=f"crack-{job_id[:8]}",
        )
        command = shlex.join(argv)
        # Gate + audit BEFORE any task is spawned (raises 403 on refusal).
        await _gate(command, target, note)

        job = CrackJob(
            id=job_id, hashfile=str(hashfile), wordlist=str(wordlist), mode=str(mode),
            target=target, note=note, argv=argv, outfile=str(outfile), potfile=str(potfile),
        )
        self._jobs[job_id] = job
        self._order.append(job_id)
        self._evict()
        job.task = asyncio.create_task(self._run(job))
        await events.bus.publish(events.JOB_STARTED, {"job_id": job_id, "type": "crack", "argv": command})
        return job

    def _evict(self) -> None:
        """Trim history to MAX_JOBS, never dropping a still-active job."""
        while len(self._order) > MAX_JOBS:
            oldest = self._order[0]
            j = self._jobs.get(oldest)
            if j and j.status in ("queued", "running"):
                break  # don't evict an active job; wait for it to finish
            self._order.pop(0)
            self._jobs.pop(oldest, None)

    # --- execution ---
    async def _run(self, job: CrackJob) -> None:
        try:
            async with self._sem:
                if job.cancelled:
                    job.status = "cancelled"
                    return
                job.status = "running"
                job.started_at = _now_iso()
                proc = await _spawn(job.argv)
                job.proc = proc
                if proc.stdout is not None:
                    async for raw in proc.stdout:
                        line = raw.decode("utf-8", errors="replace").strip()
                        if not line:
                            continue
                        if line.startswith("{"):
                            try:
                                _ingest_status_json(job, json.loads(line))
                                continue
                            except (ValueError, TypeError):
                                pass
                        job.tail.append(line)
                        if len(job.tail) > TAIL_LINES:
                            del job.tail[:-TAIL_LINES]
                rc = await proc.wait()
                job.returncode = rc
                self._finalize(job, rc)
        except asyncio.CancelledError:
            # Cancellation is a normal terminal state for a managed job, not an
            # error — record it and swallow so the task completes cleanly.
            job.status = "cancelled"
            await self._terminate(job)
        except Exception as e:  # noqa: BLE001
            log.exception("crack job %s failed", job.id)
            job.status = "error"
            job.error = str(e)
        finally:
            if job.finished_at is None:
                job.finished_at = _now_iso()
            await events.bus.publish(events.JOB_FINISHED, {"job_id": job.id, "status": job.status})

    def _finalize(self, job: CrackJob, rc: int) -> None:
        if job.cancelled or job.status == "cancelled":
            job.status = "cancelled"
            return
        cracked = _read_outfile(job.outfile)
        if cracked:
            job.cracked = cracked
            job.status = "cracked"
            job.progress = 100.0
        elif rc == 0 or job.hc_status == _HC_STATUS_CRACKED:
            # hashcat rc 0 == at least one hash cracked. An empty outfile here means
            # the hash was already in the potfile (hashcat skips re-writing -o); the
            # plaintext is recoverable from the potfile.
            job.status = "cracked"
            job.progress = 100.0
        elif rc == 1 or job.hc_status == _HC_STATUS_EXHAUSTED:
            job.status = "exhausted"
            job.progress = 100.0
        else:
            job.status = "failed"

    # --- cancellation ---
    async def _terminate(self, job: CrackJob) -> None:
        proc = job.proc
        if proc is not None and getattr(proc, "returncode", None) is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            except Exception:  # noqa: BLE001
                log.warning("terminate failed for crack job %s", job.id)

    async def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.terminal:
            return False
        job.cancelled = True
        await self._terminate(job)
        if job.task is not None and not job.task.done():
            job.task.cancel()
        if not job.terminal:
            job.status = "cancelled"
            if job.finished_at is None:
                job.finished_at = _now_iso()
        return True

    async def cancel_all(self) -> int:
        n = 0
        for job_id in list(self._jobs):
            if await self.cancel(job_id):
                n += 1
        return n


# Module-level singleton queue (shared by the router + lifecycle hooks).
queue = CrackQueue()


# --------------------------------------------------------------------------- #
# Read helpers for the web UI dropdowns / status panel
# --------------------------------------------------------------------------- #
def _list_hashfiles() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for d in (_captures_dir(), _handshakes_dir()):
        for p in sorted(d.glob("*.hc22000")):
            if p.as_posix() in seen:
                continue
            seen.add(p.as_posix())
            try:
                st = p.stat()
            except OSError:
                continue
            out.append({
                "filename": p.name,
                "path": p.as_posix(),
                "size_bytes": st.st_size,
                "mtime": datetime.utcfromtimestamp(st.st_mtime).isoformat(),
            })
    out.sort(key=lambda h: h["mtime"], reverse=True)
    return out


def _list_wordlists() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in sorted(_wordlists_dir().glob("*")):
        if p.is_file():
            out.append({"filename": p.name, "path": p.as_posix(), "size_bytes": p.stat().st_size})
    return out


# --------------------------------------------------------------------------- #
# Request body
# --------------------------------------------------------------------------- #
class CrackJobBody(BaseModel):
    hashfile: str = Field(..., description="Path/name of a captured .hc22000 under captures/ or handshakes/")
    wordlist: str | None = Field(default=None, description="Wordlist filename under wordlists/ (default rockyou.txt)")
    mode: str = Field(default=HC22000_MODE, description="hashcat -m mode (22000 or 16800)")
    target: str | None = Field(default=None, description="BSSID/ESSID the hash belongs to (scope-checked)")


# --------------------------------------------------------------------------- #
# Module
# --------------------------------------------------------------------------- #
class Module(ModuleBase):
    id = "crack"
    label = "Crack Queue"
    icon = "⛓"
    requires_engagement = True   # mirrors the inline /crack gate (nav shows the "!")
    requires_root = False        # offline — no sudo, never touches the radio

    async def on_shutdown(self) -> None:
        # The engagement kill switch only reaches runner-owned procs; cancel our
        # in-flight jobs here so a clean server stop never strands a hashcat run.
        try:
            await queue.cancel_all()
        except Exception:  # noqa: BLE001
            log.exception("crack queue shutdown cancel failed")

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status() -> dict[str, Any]:
            return {
                "ok": True,
                "module": self.id,
                "label": self.label,
                "requires_engagement": self.requires_engagement,
                "engaged": engagement.is_on(),
                "engagement": engagement.status(),
                "hashcat": {
                    "path": HASHCAT,
                    "present": bool(shutil.which("hashcat") or Path(HASHCAT).exists()),
                },
                "modes": sorted(CRACK_MODES),
                "counts": queue.counts(),
                "hashfiles": _list_hashfiles(),
                "wordlists": _list_wordlists(),
                "jobs": queue.list()[:20],
            }

        @r.get("/hashfiles")
        def hashfiles() -> dict[str, Any]:
            hs = _list_hashfiles()
            return {"ok": True, "hashfiles": hs, "count": len(hs)}

        @r.get("/wordlists")
        def wordlists() -> dict[str, Any]:
            wl = _list_wordlists()
            return {"ok": True, "wordlists": wl, "count": len(wl)}

        @r.get("/jobs")
        def jobs() -> dict[str, Any]:
            rows = queue.list()
            return {"ok": True, "jobs": rows, "count": len(rows), "counts": queue.counts()}

        @r.get("/jobs/{job_id}")
        def job_detail(job_id: str) -> dict[str, Any]:
            job = queue.get(job_id)
            if job is None:
                raise HTTPException(404, "crack job not found")
            d = job.to_dict()
            d["tail"] = job.tail[-TAIL_LINES:]
            return {"ok": True, "job": d}

        @r.post("/jobs")
        async def submit_job(body: CrackJobBody) -> dict[str, Any]:
            # Validation (400) mirrors the inline op: mode + path containment ONLY,
            # BEFORE the engagement gate — so the gate stays authoritative.
            if body.mode not in CRACK_MODES:
                raise HTTPException(400, f"unsupported hashcat mode {body.mode!r}; choose {sorted(CRACK_MODES)}")
            hashpath = _resolve_hashfile(body.hashfile)
            wordlist = _resolve_wordlist(body.wordlist)
            target = _norm_target(body.target)
            note = f"crack {hashpath.name} wordlist={wordlist.name} mode={body.mode}"
            job = await queue.submit(
                hashfile=hashpath, wordlist=wordlist, mode=body.mode, target=target, note=note,
            )
            return {"ok": True, "op": "crack", "job_id": job.id, "job": job.to_dict()}

        @r.post("/jobs/{job_id}/cancel")
        async def cancel_job(job_id: str) -> dict[str, Any]:
            job = queue.get(job_id)
            if job is None:
                raise HTTPException(404, "crack job not found")
            cancelled = await queue.cancel(job_id)
            return {"ok": True, "cancelled": cancelled, "job": job.to_dict()}

        return r
