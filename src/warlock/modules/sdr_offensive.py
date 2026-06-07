"""Offensive SDR — engagement-gated RF capture / replay / analysis.

GATED MODULE. RF operations are dangerous and legally fraught, so every
state-changing op routes through the SAME engagement gate the other offensive
modules use (``warlock.jobs.runner.submit(requires_engagement=True)``) — which
also makes them reachable by the engagement kill switch (``runner.cancel_all``):

  GET  /api/sdr_offensive/status   device + busy summary, captures, last_result
  POST /api/sdr_offensive/capture  record IQ to a file (RX) — engagement-gated + audit
  POST /api/sdr_offensive/replay   transmit a capture (TX, RF-EMITTING) — gated + audit
  POST /api/sdr_offensive/analyze  offline summary of a capture — light, NO gate

The gate (``runner.submit``) is authoritative: engagement OFF or an out-of-scope
target → HTTP 403 ``{detail}`` + a ``scope.violation`` audit row + an alert; an
accepted op → a ``job.submit`` audit row. Tool presence is only PROBED inside the
would-allow branch (mirrors wifi_offensive) so device state never leaks to an
unauthorised caller; a missing radio yields a clean ``error="unavailable"``
result, never a crash.

JSON contract (ratified with web-p3 / agent-p3 — these field names are load-
bearing for the web lane):
  * status   → {ok, rx_device, tx_device, tx_capable, busy, reason, captures[],
                last_result}     (+ additive engaged / engagement / requires_engagement)
  * captures[] row → {id, filename, path, freq_mhz, sample_rate, duration_s,
                      size_bytes, created_at, modulation}
  * every action → {ok, op, detail, audit_id, error, ts, job_id}  (job_id additive;
                    null for analyze) — also stored as status.last_result.

Units: ``freq_mhz`` is megahertz; ``sample_rate`` is samples/sec (Hz).

``target`` is an OPTIONAL, additive field on capture/replay. Omitted → the op
gates on engagement-active only (refused unless an engagement is on). Supplied →
it is ALSO scope-checked (``check_target``) so an operator can hard-bind an RF op
to an in-scope authorising target.

Tooling: RTL-SDR is RX-only, so ``capture`` auto-selects ``rtl_sdr`` (preferred)
or ``hackrf_transfer``; TRANSMIT (``replay``) needs a TX-capable radio —
``hackrf_transfer -t`` (HackRF). ``analyze`` is dependency-free (a file-stats
summary) so it always works.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import shlex
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc

from warlock.config import get_settings
from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.jobs import runner
from warlock.models import AuditEntry, Job
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.sdr_offensive")

# --- tool paths (resolved at import; fall back to canonical install locations) -
HACKRF_TRANSFER = shutil.which("hackrf_transfer") or "/usr/bin/hackrf_transfer"
RTL_SDR = shutil.which("rtl_sdr") or "/usr/bin/rtl_sdr"
URH_CLI = shutil.which("urh_cli") or "/usr/bin/urh_cli"

CAPTURE_TOOLS = ("hackrf", "rtl_sdr")   # RX-capable radios
TX_TOOL = "hackrf"                       # only HackRF can transmit (RF emit)

# RF guardrails (defense in depth on top of the pydantic Field bounds).
_FREQ_MIN_MHZ = 1.0          # 1 MHz
_FREQ_MAX_MHZ = 6000.0       # 6 GHz (HackRF ceiling)
_SR_MIN = 1_000_000          # samples/sec
_SR_MAX = 20_000_000
_ANALYZE_READ_CAP = 1_000_000     # bytes read for the coarse power estimate

# Last action result (status.last_result). Module-level singleton like the other
# modules' shared state (crack.queue, ops._event_ring).
_LAST_RESULT: dict[str, Any] | None = None


# --------------------------------------------------------------------------- #
# Data dir + path safety
# --------------------------------------------------------------------------- #
def _captures_dir() -> Path:
    p = get_settings().data / "captures" / "sdr"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _contained(path: Path, root: Path) -> bool:
    """True if *path* resolves inside *root* (blocks ../ traversal)."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _resolve_capture(capture: str | None, path: str | None) -> Path:
    """Resolve a capture reference to a path under captures/sdr/ (blocks traversal;
    400 on escape / when neither is given). ``path`` wins when supplied; otherwise
    ``capture`` is matched as a filename OR a row id (the filename stem). Existence
    is NOT checked here — callers defer that to inside the would-allow branch so
    file state never leaks to an unauthorised caller."""
    d = _captures_dir()
    raw_path = (path or "").strip()
    if raw_path:
        p = Path(raw_path)
    else:
        raw = (capture or "").strip()
        if not raw:
            raise HTTPException(400, "capture (id or filename) or path is required")
        if "/" in raw:
            p = Path(raw)
        else:
            cand = d / raw
            if cand.exists():
                p = cand
            else:
                stem_hits = [f for f in d.glob("*.iq") if f.is_file() and f.stem == raw]
                p = stem_hits[0] if stem_hits else cand
    if not _contained(p, d):
        raise HTTPException(400, f"capture must live under {d}")
    return p


def _present(name: str, path: str) -> bool:
    return bool(shutil.which(name) or Path(path).exists())


def _tool_missing(tool: str) -> bool:
    """True if the binary backing *tool* is not installed."""
    if tool == "hackrf":
        return not _present("hackrf_transfer", HACKRF_TRANSFER)
    if tool == "rtl_sdr":
        return not _present("rtl_sdr", RTL_SDR)
    return True


def _rx_device() -> str | None:
    """The auto-selected RX capture radio (rtl_sdr preferred), or None if absent."""
    if _present("rtl_sdr", RTL_SDR):
        return "rtl_sdr"
    if _present("hackrf_transfer", HACKRF_TRANSFER):
        return "hackrf"
    return None


def _tx_device() -> str | None:
    """The TX-capable radio (HackRF only), or None if absent."""
    return "hackrf" if _present("hackrf_transfer", HACKRF_TRANSFER) else None


def _would_allow(target: str) -> bool:
    """Cheap, side-effect-free pre-check: would the authoritative gate accept?

    Mirrors wifi_offensive — used ONLY to decide whether to probe device/file
    state. The real gate is ``runner.submit(requires_engagement=True)``.
    """
    return engagement.is_on() and (not target or engagement.check_target(target))


# --------------------------------------------------------------------------- #
# Capture metadata sidecar + listing
# --------------------------------------------------------------------------- #
def _meta_path(iq: Path) -> Path:
    return iq.with_name(iq.name + ".meta.json")


def _write_meta(iq: Path, *, freq_mhz: float, sample_rate: int, duration_s: int,
                modulation: str | None = None) -> None:
    data = {
        "freq_mhz": freq_mhz,
        "sample_rate": int(sample_rate),
        "duration_s": int(duration_s),
        "modulation": modulation,
        "created_at": datetime.utcnow().isoformat(),
    }
    try:
        _meta_path(iq).write_text(json.dumps(data))
    except OSError as e:  # never let a sidecar write break the op
        log.warning("capture meta write failed for %s: %s", iq, e)


def _read_meta(iq: Path) -> dict[str, Any]:
    try:
        out = json.loads(_meta_path(iq).read_text())
        return out if isinstance(out, dict) else {}
    except (OSError, ValueError):
        return {}


def _list_captures() -> list[dict[str, Any]]:
    """List .iq captures (a sibling ``<name>.meta.json`` sidecar enriches each row;
    missing fields degrade to null per the ratified contract)."""
    out: list[dict[str, Any]] = []
    for p in sorted(_captures_dir().glob("*.iq")):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        meta = _read_meta(p)
        out.append({
            "id": p.stem,                 # stable selection id (filename stem)
            "filename": p.name,
            "path": p.as_posix(),
            "freq_mhz": meta.get("freq_mhz"),
            "sample_rate": meta.get("sample_rate"),
            "duration_s": meta.get("duration_s"),
            "size_bytes": st.st_size,
            "created_at": meta.get("created_at")
            or datetime.utcfromtimestamp(st.st_mtime).isoformat(),
            "modulation": meta.get("modulation"),
        })
    out.sort(key=lambda c: c["created_at"], reverse=True)
    return out


# --------------------------------------------------------------------------- #
# Audit-id lookup + uniform action result
# --------------------------------------------------------------------------- #
def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _audit_id_for(command: str, kind: str) -> str | None:
    """The id of the AuditEntry ``runner.submit`` just wrote for *command*.

    ``runner.submit`` audits by ``command = shlex.join(argv)`` + its sha256; the
    capture argv carries a unique timestamped outfile, so the sha pins the exact
    row. Best-effort — returns None if not found."""
    sha = _sha256(command)
    with session_scope() as s:
        row = (
            s.query(AuditEntry)
            .filter(AuditEntry.kind == kind, AuditEntry.sha256 == sha)
            .order_by(desc(AuditEntry.ts))
            .first()
        )
        return row.id if row else None


def _result(*, ok: bool, op: str, detail: str = "", audit_id: str | None = None,
            error: str | None = None, job_id: str | None = None) -> dict[str, Any]:
    """Build + remember the uniform action result (also served as last_result)."""
    global _LAST_RESULT
    r = {
        "ok": ok, "op": op, "detail": detail, "audit_id": audit_id,
        "error": error, "ts": datetime.utcnow().isoformat(), "job_id": job_id,
    }
    _LAST_RESULT = r
    return r


def _busy() -> tuple[bool, str]:
    """True if an sdr.capture/sdr.replay job is currently starting/running."""
    with session_scope() as s:
        row = (
            s.query(Job)
            .filter(Job.type.in_(("sdr.capture", "sdr.replay")),
                    Job.status.in_(("starting", "running")))
            .order_by(desc(Job.started_at))
            .first()
        )
        return (True, f"{row.type} running") if row is not None else (False, "")


# --------------------------------------------------------------------------- #
# Pure command builders — every interpolated value is int-coerced or a path.
# --------------------------------------------------------------------------- #
def _capture_command(
    *, tool: str, freq_hz: int, sample_rate: int, duration_s: int, outfile: Path,
) -> list[str]:
    """RX capture argv. Bounded by ``timeout`` AND a ``-n`` sample count so a
    capture can never run unbounded. ``hackrf_transfer -r`` and ``rtl_sdr`` both
    write raw interleaved IQ to *outfile*."""
    freq_hz, sample_rate, duration_s = int(freq_hz), int(sample_rate), int(duration_s)
    samples = sample_rate * duration_s
    guard = str(duration_s + 5)  # wall-clock backstop a few s beyond the sample count
    if tool == "hackrf":
        return ["timeout", guard, HACKRF_TRANSFER, "-r", str(outfile),
                "-f", str(freq_hz), "-s", str(sample_rate), "-n", str(samples)]
    if tool == "rtl_sdr":
        return ["timeout", guard, RTL_SDR, "-f", str(freq_hz),
                "-s", str(sample_rate), "-n", str(samples), str(outfile)]
    raise HTTPException(400, f"unsupported capture tool {tool!r}; choose {list(CAPTURE_TOOLS)}")


def _replay_command(
    *, capture: Path, freq_hz: int, sample_rate: int, tx_gain: int,
) -> list[str]:
    """TX replay argv (HackRF only). ``-t`` transmits the raw IQ file; ``-x`` is
    the TX VGA gain (dB). Bounded by ``timeout`` so a transmission can't run
    unbounded."""
    return ["timeout", "120", HACKRF_TRANSFER, "-t", str(capture),
            "-f", str(int(freq_hz)), "-s", str(int(sample_rate)), "-x", str(int(tx_gain))]


# --------------------------------------------------------------------------- #
# Offline analysis (light, dependency-free): file stats + coarse power.
# --------------------------------------------------------------------------- #
def _analyze_capture(path: Path, *, sample_rate: int) -> dict[str, Any]:
    """Summarise a raw interleaved-IQ capture WITHOUT any external tool.

    Treats the file as interleaved 8-bit I/Q (rtl_sdr is uint8, hackrf is int8 —
    centring on the byte mean of a capped head read is robust to either). Returns
    sample count, estimated duration, and a coarse RMS/peak magnitude — a 'light'
    summary, not real DSP. Never raises on a read error (returns nulls)."""
    size = path.stat().st_size
    bytes_per_sample = 2  # one I byte + one Q byte
    samples = size // bytes_per_sample
    sr = max(1, int(sample_rate))
    duration_s = round(samples / sr, 4) if samples else 0.0
    rms = None
    peak = None
    analyzed = 0
    try:
        with path.open("rb") as fh:
            chunk = fh.read(_ANALYZE_READ_CAP)
        analyzed = len(chunk)
        n = (len(chunk) // 2) * 2
        if n:
            mean = sum(chunk[:n]) / n
            acc = 0.0
            pk_sq = 0.0
            for i in range(0, n, 2):
                di = chunk[i] - mean
                dq = chunk[i + 1] - mean
                m2 = di * di + dq * dq
                acc += m2
                if m2 > pk_sq:
                    pk_sq = m2
            pairs = n // 2
            rms = round(math.sqrt(acc / pairs), 3)
            peak = round(math.sqrt(pk_sq), 3)
    except OSError as e:
        log.warning("analyze read failed for %s: %s", path, e)
    return {
        "size_bytes": size,
        "samples": samples,
        "sample_rate": sr,
        "duration_s": duration_s,
        "rms_magnitude": rms,
        "peak_magnitude": peak,
        "analyzed_bytes": analyzed,
    }


# --------------------------------------------------------------------------- #
# Request bodies (ratified contract; target is an additive optional extra)
# --------------------------------------------------------------------------- #
class CaptureBody(BaseModel):
    freq_mhz: float = Field(..., ge=_FREQ_MIN_MHZ, le=_FREQ_MAX_MHZ, description="Centre frequency (MHz)")
    sample_rate: int = Field(default=2_000_000, ge=_SR_MIN, le=_SR_MAX, description="Sample rate (samples/sec)")
    duration_s: int = Field(default=5, ge=1, le=300, description="Capture window (seconds)")
    target: str | None = Field(default=None, description="Optional in-scope target authorising the op (scope-checked when set)")


class ReplayBody(BaseModel):
    capture: str | None = Field(default=None, description="Capture id or filename under captures/sdr/")
    path: str | None = Field(default=None, description="Full path to the capture (under captures/sdr/)")
    freq_mhz: float = Field(..., ge=_FREQ_MIN_MHZ, le=_FREQ_MAX_MHZ, description="TX centre frequency (MHz)")
    sample_rate: int = Field(default=2_000_000, ge=_SR_MIN, le=_SR_MAX, description="Sample rate (samples/sec)")
    tx_gain: int = Field(default=0, ge=0, le=47, description="HackRF TX VGA gain (dB)")
    # RF emission is the most dangerous op — target is REQUIRED and ALWAYS
    # scope-checked: replay needs an active engagement AND an in-scope authorising
    # target (the operator must add it to the engagement scope first).
    target: str = Field(..., min_length=1, description="In-scope target authorising this RF emission (required)")


class AnalyzeBody(BaseModel):
    capture: str | None = Field(default=None, description="Capture id or filename under captures/sdr/")
    path: str | None = Field(default=None, description="Full path to the capture (under captures/sdr/)")


# --------------------------------------------------------------------------- #
# Module
# --------------------------------------------------------------------------- #
class Module(ModuleBase):
    id = "sdr_offensive"
    label = "Offensive SDR"
    icon = "☢"
    requires_engagement = True

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.sdr_offensive import SdrOffensiveScreen

        return SdrOffensiveScreen()

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status() -> dict[str, Any]:
            rx = _rx_device()
            tx = _tx_device()
            busy, busy_reason = _busy()
            if busy:
                reason = busy_reason
            elif rx is None and tx is None:
                reason = "no SDR device detected"
            else:
                reason = ""
            return {
                "ok": True,
                "rx_device": rx,
                "tx_device": tx,
                "tx_capable": tx is not None,
                "busy": busy,
                "reason": reason,
                # Per-tool presence/path (additive — Ink SDR screen reads `tools`;
                # web ignores extras). rx_device/tx_device/tx_capable stay as-is.
                "tools": {
                    "hackrf": {"present": _present("hackrf_transfer", HACKRF_TRANSFER), "path": HACKRF_TRANSFER},
                    "rtl_sdr": {"present": _present("rtl_sdr", RTL_SDR), "path": RTL_SDR},
                    "urh": {"present": _present("urh_cli", URH_CLI), "path": URH_CLI},
                },
                "captures": _list_captures(),
                "last_result": _LAST_RESULT,
                # additive (harmless extras the agent/Ink lanes find useful):
                "requires_engagement": self.requires_engagement,
                "engaged": engagement.is_on(),
                "engagement": engagement.status(),
            }

        # ----- capture (RX, engagement-gated) ------------------------------- #
        @r.post("/capture")
        async def capture(body: CaptureBody) -> dict[str, Any]:
            target = (body.target or "").strip()
            freq_hz = round(body.freq_mhz * 1_000_000)  # round, not int (float drift)
            tool = _rx_device()
            stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            outfile = _captures_dir() / f"capture-{body.freq_mhz:g}MHz-{stamp}.iq"
            # Probe device state ONLY for an op the gate would allow (no leak to an
            # unauthorised caller). No RX radio → a clean 'unavailable' result.
            if _would_allow(target) and tool is None:
                return _result(ok=False, op="capture", error="unavailable",
                               detail="no RX SDR device detected (install rtl_sdr or hackrf)")
            argv = _capture_command(
                tool=tool or "hackrf", freq_hz=freq_hz,
                sample_rate=body.sample_rate, duration_s=body.duration_s, outfile=outfile,
            )
            command = shlex.join(argv)
            note = f"sdr capture {tool} f={body.freq_mhz}MHz sr={body.sample_rate} dur={body.duration_s}s"
            try:
                job_id = await runner.submit(
                    "sdr.capture", argv, requires_engagement=True, target=target, note=note,
                )
            except PermissionError as e:
                aid = _audit_id_for(command, "scope.violation")
                _result(ok=False, op="capture", error="refused", detail=str(e), audit_id=aid)
                raise HTTPException(403, str(e)) from e
            _write_meta(outfile, freq_mhz=body.freq_mhz,
                        sample_rate=body.sample_rate, duration_s=body.duration_s)
            return _result(
                ok=True, op="capture", job_id=job_id,
                audit_id=_audit_id_for(command, "job.submit"),
                detail=(f"capture started: {body.freq_mhz:g} MHz, {body.sample_rate} sps, "
                        f"{body.duration_s}s → {outfile.name}"),
            )

        # ----- replay (TX, RF-EMITTING — gated) ----------------------------- #
        @r.post("/replay")
        async def replay(body: ReplayBody) -> dict[str, Any]:
            target = (body.target or "").strip()
            # Required + non-empty: a whitespace-only target would otherwise reach
            # runner.submit as "" and skip the scope check under an active
            # engagement. RF emission ALWAYS requires an in-scope target.
            if not target:
                raise HTTPException(400, "replay requires a non-empty in-scope target authorising the RF emission")
            freq_hz = round(body.freq_mhz * 1_000_000)  # round, not int (float drift)
            cappath = _resolve_capture(body.capture, body.path)
            # Existence + device probes live INSIDE the would-allow branch so a
            # refused (engagement-off / out-of-scope) caller learns nothing about
            # file or device state — the gate stays authoritative.
            if _would_allow(target):
                if not cappath.exists():
                    raise HTTPException(404, "capture not found")
                if _tool_missing(TX_TOOL):
                    return _result(ok=False, op="replay", error="unavailable",
                                   detail="hackrf_transfer not installed (RF transmit needs a HackRF)")
            argv = _replay_command(
                capture=cappath, freq_hz=freq_hz,
                sample_rate=body.sample_rate, tx_gain=body.tx_gain,
            )
            command = shlex.join(argv)
            note = (f"sdr REPLAY (TX) {cappath.name} f={body.freq_mhz}MHz "
                    f"sr={body.sample_rate} gain={body.tx_gain}")
            try:
                job_id = await runner.submit(
                    "sdr.replay", argv, requires_engagement=True, target=target, note=note,
                )
            except PermissionError as e:
                aid = _audit_id_for(command, "scope.violation")
                _result(ok=False, op="replay", error="refused", detail=str(e), audit_id=aid)
                raise HTTPException(403, str(e)) from e
            return _result(
                ok=True, op="replay", job_id=job_id,
                audit_id=_audit_id_for(command, "job.submit"),
                detail=f"REPLAY (TX) {cappath.name} at {body.freq_mhz:g} MHz — job {job_id}",
            )

        # ----- analyze (offline summary — light, NO gate) ------------------- #
        @r.post("/analyze")
        def analyze(body: AnalyzeBody) -> dict[str, Any]:
            cappath = _resolve_capture(body.capture, body.path)
            if not cappath.exists():
                raise HTTPException(404, "capture not found")
            meta = _read_meta(cappath)
            sr = int(meta.get("sample_rate") or 2_000_000)
            stats = _analyze_capture(cappath, sample_rate=sr)
            detail = (f"{stats['duration_s']}s, {stats['samples']} samples @ {sr} sps, "
                      f"rms={stats['rms_magnitude']} peak={stats['peak_magnitude']} "
                      f"({stats['analyzed_bytes']}/{stats['size_bytes']} bytes analysed)")
            return _result(ok=True, op="analyze", detail=detail)

        return r
