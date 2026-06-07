"""Async job runner with SQLite persistence + audit trail."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import shlex
from collections.abc import Iterable
from datetime import datetime
from uuid import uuid4

from warlock import events
from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.models import AuditEntry, Job

log = logging.getLogger("warlock.jobs")


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _emit_aar(kind: str, command: str, target: str, note: str, outcome: str) -> None:
    """Best-effort: emit a signed AAR proof for this audit event. Lazy-imported +
    fully guarded so a missing dep or signing error can NEVER break the audit
    write or the job submission."""
    try:
        from warlock import aar

        aar.safe_emit_for_audit(
            kind=kind, command=command, target=target, note=note, outcome=outcome
        )
    except Exception:  # noqa: BLE001 — AAR is additive; the audit row already landed
        log.warning("AAR emit hook failed (non-fatal) for %s", kind, exc_info=True)


class JobRunner:
    """Launches asyncio subprocess jobs, persists state, emits events.

    All engagement-gated invocations MUST go through `submit_guarded` which
    consults `engagement.check_target` first and writes an audit entry.
    """

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}

    async def submit(
        self,
        type_: str,
        argv: Iterable[str],
        *,
        requires_engagement: bool = False,
        target: str = "",
        note: str = "",
    ) -> str:
        argv = list(argv)
        command = shlex.join(argv)
        job_id = str(uuid4())

        # Engagement gate.
        if requires_engagement:
            if not engagement.is_on():
                await self._record_scope_violation(command, target, note, reason="engagement-off")
                raise PermissionError("engagement mode is OFF; refusing offensive invocation")
            if target and not engagement.check_target(target):
                await self._record_scope_violation(command, target, note, reason="out-of-scope")
                raise PermissionError(f"target {target!r} is not in engagement scope allowlist")

        # Persist.
        with session_scope() as s:
            s.add(
                Job(
                    id=job_id,
                    type=type_,
                    status="starting",
                    argv=command,
                    engagement_id=engagement.engagement_id,
                )
            )

        # Audit (if under engagement).
        if engagement.is_on():
            with session_scope() as s:
                s.add(
                    AuditEntry(
                        engagement_id=engagement.engagement_id,
                        kind="job.submit",
                        command=command,
                        sha256=_sha256(command),
                        target=target,
                        note=note,
                        outcome="submitted",
                    )
                )
            _emit_aar("job.submit", command, target, note, "submitted")

        task = asyncio.create_task(self._run(job_id, argv))
        self._tasks[job_id] = task
        await events.bus.publish(events.JOB_STARTED, {"job_id": job_id, "type": type_, "argv": command})
        return job_id

    async def _run(self, job_id: str, argv: list[str]) -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._procs[job_id] = proc
            self._update(job_id, status="running")
            stdout_b, stderr_b = await proc.communicate()
            ok = proc.returncode == 0
            self._update(
                job_id,
                status="success" if ok else "failed",
                stdout=(stdout_b or b"").decode("utf-8", errors="replace"),
                stderr=(stderr_b or b"").decode("utf-8", errors="replace"),
                finished_at=datetime.utcnow(),
            )
            await events.bus.publish(
                events.JOB_FINISHED,
                {"job_id": job_id, "status": "success" if ok else "failed", "rc": proc.returncode},
            )
        except asyncio.CancelledError:
            self._update(job_id, status="cancelled", finished_at=datetime.utcnow())
            await events.bus.publish(events.JOB_FINISHED, {"job_id": job_id, "status": "cancelled"})
            raise
        except Exception as e:  # noqa: BLE001
            self._update(job_id, status="errored", stderr=str(e), finished_at=datetime.utcnow())
            await events.bus.publish(events.JOB_FINISHED, {"job_id": job_id, "status": "errored"})
        finally:
            self._procs.pop(job_id, None)
            self._tasks.pop(job_id, None)

    def _update(self, job_id: str, **fields) -> None:
        with session_scope() as s:
            row = s.get(Job, job_id)
            if row is None:
                return
            for k, v in fields.items():
                setattr(row, k, v)

    async def cancel(self, job_id: str) -> bool:
        proc = self._procs.get(job_id)
        if proc and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        t = self._tasks.get(job_id)
        if t:
            t.cancel()
        return bool(proc or t)

    async def cancel_all(self) -> int:
        jobs = list(self._procs.keys())
        for jid in jobs:
            await self.cancel(jid)
        return len(jobs)

    @staticmethod
    async def _record_scope_violation(command: str, target: str, note: str, *, reason: str) -> None:
        with session_scope() as s:
            s.add(
                AuditEntry(
                    engagement_id=engagement.engagement_id,
                    kind="scope.violation",
                    command=command,
                    sha256=_sha256(command),
                    target=target,
                    note=f"{reason}: {note}",
                    outcome="refused",
                )
            )
        _emit_aar("scope.violation", command, target, f"{reason}: {note}", "refused")
        await events.bus.publish(
            events.ALERT_FIRED,
            {"severity": "warning", "source": "engagement", "message": f"scope violation: {reason}"},
        )


runner = JobRunner()
