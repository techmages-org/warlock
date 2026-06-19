"""Operations — engagement lifecycle module.

Exposes `/api/ops/*` endpoints that front the existing
``warlock.engagement.engagement`` singleton + SQLite-backed ``Engagement``
rows. The legacy ``/api/engagements/*`` router stays in place; ops is the
canonical module-facing surface (status, create+activate in one shot,
history, audit, killswitch).
"""
from __future__ import annotations

import asyncio
import html as html_lib
import logging
import re
import threading
from collections import deque
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import desc

from warlock import events
from warlock.config import get_settings
from warlock.db import session_scope
from warlock.engagement import ScopeAllowlist, engagement, engagement_lock
from warlock.models import AuditEntry, Engagement, Job, Scan
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.ops")


# --------------------------------------------------------------------------- #
# Live activity / loot feed ("the pager") — a subscriber drains the shared
# ``ALERT_FIRED`` bus into a newest-first ring buffer that the web Pager polls
# via ``GET /api/ops/events``. Bus events (IDS alerts, recon findings, scope
# violations) are folded together with recent audit rows (gated-op activity) so
# one feed shows both alerts and operator actions.
#
# Thread-safety: the subscriber task appends from the asyncio loop thread while
# the sync ``/events`` handler reads from a threadpool thread, so the ring is
# guarded by a ``threading.Lock`` — both ends touch the same singleton buffer.
# --------------------------------------------------------------------------- #
_FEED_MAX = 50


class _EventRing:
    """Bounded, thread-safe, newest-first activity buffer."""

    def __init__(self, maxlen: int = _FEED_MAX) -> None:
        self._buf: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def push(self, item: dict[str, Any]) -> None:
        with self._lock:
            self._buf.append(item)

    def snapshot(self) -> list[dict[str, Any]]:
        """Return a newest-first copy of the buffered events."""
        with self._lock:
            return list(reversed(self._buf))

    def clear(self) -> None:
        with self._lock:
            self._buf.clear()


# Module-global singleton: the bus is a singleton, so the feed is too.
_event_ring = _EventRing()


def _norm_alert(evt: events.Event) -> dict[str, Any]:
    """Normalise an ``ALERT_FIRED`` bus event into a feed row.

    Publishers (net_recon, crack, jobs, server_audit) emit
    ``{severity, source, message}``; we surface those plus the event ts.
    """
    p = evt.payload or {}
    return {
        "ts": evt.ts,
        "source": str(p.get("source") or "system"),
        "severity": str(p.get("severity") or "info"),
        "kind": "alert",
        "text": str(p.get("message") or evt.name),
    }


def _audit_to_event(a: AuditEntry) -> dict[str, Any]:
    """Normalise a recent audit row into the same feed-row shape."""
    kind = a.kind or "audit"
    if a.outcome == "refused" or kind == "scope.violation":
        severity = "warning"
    else:
        severity = "info"
    parts = [p for p in (a.target, a.note) if p]
    return {
        "ts": a.ts.isoformat() if a.ts else None,
        "source": "ops",
        "severity": severity,
        "kind": kind,
        "text": " · ".join(str(p) for p in parts) or kind,
    }


def _record_alert(evt: events.Event) -> None:
    """Push a single bus alert into the ring (best-effort)."""
    try:
        _event_ring.push(_norm_alert(evt))
    except Exception:  # noqa: BLE001 — the feed must never break a publisher
        log.exception("pager: failed to record alert event")


async def _consume_bus() -> None:
    """Long-lived subscriber: drain ``ALERT_FIRED`` events into the ring.

    Resolves ``events.bus.subscribe`` at call time so tests can monkeypatch the
    bus with a finite async generator.
    """
    async for evt in events.bus.subscribe():
        if evt.name != events.ALERT_FIRED:
            continue
        _record_alert(evt)


def _recent_audit_events(limit: int) -> list[dict[str, Any]]:
    """Pull the most recent audit rows, normalised to feed rows."""
    with session_scope() as s:
        rows = (
            s.query(AuditEntry)
            .order_by(desc(AuditEntry.ts))
            .limit(limit)
            .all()
        )
        return [_audit_to_event(a) for a in rows]


def _build_feed(limit: int, *, include_audit: bool) -> list[dict[str, Any]]:
    """Merge bus alerts + (optional) audit rows, newest-first, capped to limit."""
    feed = _event_ring.snapshot()
    if include_audit:
        feed = feed + _recent_audit_events(limit)
    # ts values are naive UTC ISO strings → lexical sort == chronological sort.
    feed.sort(key=lambda e: e.get("ts") or "", reverse=True)
    return feed[:limit]


class CreateEngagementBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    authorization: str = Field(..., min_length=1)
    targets: list[str] = Field(default_factory=list)
    duration_hours: float = Field(default=4.0, ge=0.25, le=24 * 14)


class AddScopeBody(BaseModel):
    targets: list[str] = Field(..., min_length=1)


# Placeholder/label literals the web form ships as input hints. Submitting these
# verbatim would create (or grow) a scope that gates nothing — the blank-scope
# bug. Real SSIDs won't collide with this tiny denylist.
_PLACEHOLDER_TOKENS = {"ssid", "bssid", "ip/cidr", "cidr", "ssids", "bssids"}


def _reject_placeholder_or_empty(targets: list[str]) -> None:
    """Raise HTTP 400 if scope is all-blank OR contains a placeholder literal."""
    cleaned = [t for t in ((raw or "").strip() for raw in targets) if t]
    if not cleaned:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "targets must include at least one SSID / BSSID / IP / CIDR",
        )
    bad = sorted({t for t in cleaned if t.lower() in _PLACEHOLDER_TOKENS})
    if bad:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "placeholder/label tokens are not valid scope targets: " + ", ".join(bad),
        )


def _split_targets(targets: list[str]) -> ScopeAllowlist:
    """Heuristic splitter: IP/CIDR → ip_ranges, hex MACs → bssids, else ssids."""
    ssids: list[str] = []
    bssids: list[str] = []
    ip_ranges: list[str] = []
    for raw in targets:
        t = (raw or "").strip()
        if not t:
            continue
        low = t.lower()
        # MAC: 12 hex digits with five separators (: or -)
        hex_only = low.replace(":", "").replace("-", "")
        if len(hex_only) == 12 and all(c in "0123456789abcdef" for c in hex_only):
            bssids.append(low)
            continue
        # CIDR / IP: contains slash or parses as ipaddress
        if "/" in t:
            ip_ranges.append(t)
            continue
        try:
            import ipaddress as _ip

            _ip.ip_address(t)
            ip_ranges.append(t)
            continue
        except ValueError:
            pass
        ssids.append(t)
    return ScopeAllowlist(ssids=ssids, bssids=bssids, ip_ranges=ip_ranges)


def _elapsed_s(started: datetime | None) -> int | None:
    if started is None:
        return None
    return int((datetime.utcnow() - started).total_seconds())


def _engagement_detail_row(row: Engagement) -> dict[str, Any]:
    with session_scope() as s:
        audit_count = (
            s.query(AuditEntry)
            .filter(AuditEntry.engagement_id == row.id)
            .count()
        )
        jobs_count = s.query(Job).filter(Job.engagement_id == row.id).count()
    return {
        "id": row.id,
        "name": row.name,
        "auth_statement": row.auth_statement,
        "scope": row.scope,
        "status": row.status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "ended_at": row.ended_at.isoformat() if row.ended_at else None,
        "audit_count": audit_count,
        "jobs_count": jobs_count,
    }


# --------------------------------------------------------------------------- #
# Report generation — client-ready md + HTML built from an engagement's
# DB row (meta/scope/auth), its audit log (timeline + forensic trail), the
# jobs it ran (op-type counts), its scans (recon results) and the artifacts
# captured under engagements/<uuid>/ (creds + engagement metadata).
# --------------------------------------------------------------------------- #
class ReportBody(BaseModel):
    engagement_id: str = Field(..., min_length=1)


# File categories found under engagements/<uuid>/. Capture/hash/credentials are
# treated as "evidence" (real findings); the rest are operational metadata.
_EVIDENCE_CATEGORIES = {"capture", "hash", "credentials", "scan"}
# Capture-file extensions we recognise inside a job's argv (handshake/PMKID).
_CAPTURE_RE = re.compile(r"[\w./-]+\.(?:pcapng|pcap|cap|hc22000)", re.IGNORECASE)


def _human_size(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if f < 1024 or unit == "GB":
            return f"{int(f)} {unit}" if unit == "B" else f"{f:.1f} {unit}"
        f /= 1024.0
    return f"{f:.1f} GB"


def _slug(name: str) -> str:
    s = "".join(c if c.isalnum() else "-" for c in (name or "").lower())
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-") or "engagement"


def _fmt_dt(iso: str | None) -> str:
    if not iso:
        return "—"
    return iso.replace("T", " ")[:19]


def _fmt_duration(secs: int | None, ongoing: bool) -> str:
    if secs is None:
        return "—"
    secs = max(0, secs)
    h, rem = divmod(secs, 3600)
    m = rem // 60
    base = f"{h}h {m:02d}m"
    return f"{base} (ongoing)" if ongoing else base


def _cell(v: Any) -> str:
    """Sanitise a value for a single markdown table cell."""
    s = str(v if v is not None else "")
    s = s.replace("|", "\\|").replace("\n", " ").replace("\r", " ").strip()
    return s or "—"


def _classify_artifact(name: str) -> str:
    low = name.lower()
    if low in {"engagement.yaml", "engagement.yml"}:
        return "metadata"
    if low == "audit.log":
        return "audit-log"
    if low == "killswitch.log":
        return "killswitch-log"
    if low.endswith((".cap", ".pcap", ".pcapng")):
        return "capture"
    if low.endswith(".hc22000"):
        return "hash"
    if low.startswith("creds") or "creds" in low:
        return "credentials"
    if low.endswith(".xml") or low.startswith("scan") or "nmap" in low:
        return "scan"
    return "other"


def _scan_artifacts(engagement_id: str) -> list[dict[str, Any]]:
    """Enumerate files under engagements/<uuid>/ (creds + engagement metadata).

    Intentionally engagement-scoped: handshake/PMKID captures live in the
    *global* captures/ + handshakes/ dirs and are NOT pulled in here (doing so
    would leak other engagements' evidence into a client report). Capture paths
    that belong to this engagement are surfaced from job argv instead.
    """
    base = get_settings().engagement_dir() / engagement_id
    out: list[dict[str, Any]] = []
    if not base.exists():
        return out
    for p in sorted(base.rglob("*")):
        if not p.is_file():
            continue
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        out.append(
            {
                "name": p.relative_to(base).as_posix(),
                "category": _classify_artifact(p.name),
                "size": size,
                "size_h": _human_size(size),
            }
        )
    return out


def _report_core(engagement_id: str) -> dict[str, Any] | None:
    """Pull engagement meta + audit timeline + job/scan rollups from the DB."""
    with session_scope() as s:
        row = s.get(Engagement, engagement_id)
        if row is None:
            return None

        started = row.started_at
        ended = row.ended_at
        ongoing = started is not None and ended is None
        end_ref = ended or (datetime.utcnow() if started else None)
        duration_s = (
            int((end_ref - started).total_seconds())
            if (started and end_ref)
            else None
        )

        meta = {
            "id": row.id,
            "name": row.name,
            "operator": row.operator,
            "status": row.status,
            "auth_statement": row.auth_statement or "",
            "scope": dict(row.scope or {}),
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "started_at": started.isoformat() if started else None,
            "ended_at": ended.isoformat() if ended else None,
        }

        audit = [
            {
                "ts": a.ts.isoformat() if a.ts else None,
                "kind": a.kind,
                "command": a.command,
                "sha256": a.sha256,
                "target": a.target,
                "note": a.note,
                "outcome": a.outcome,
            }
            for a in (
                s.query(AuditEntry)
                .filter(AuditEntry.engagement_id == engagement_id)
                .order_by(AuditEntry.ts)
                .all()
            )
        ]

        jobs = (
            s.query(Job)
            .filter(Job.engagement_id == engagement_id)
            .order_by(Job.started_at)
            .all()
        )
        jobs_by_type: dict[str, int] = {}
        capture_paths: list[str] = []
        for j in jobs:
            jobs_by_type[j.type] = jobs_by_type.get(j.type, 0) + 1
            for m in _CAPTURE_RE.findall(j.argv or ""):
                if m not in capture_paths:
                    capture_paths.append(m)

        scans = [
            {
                "target": sc.target,
                "profile": sc.profile,
                "status": sc.status,
                "hosts_found": sc.hosts_found,
                "started_at": sc.started_at.isoformat() if sc.started_at else None,
            }
            for sc in (
                s.query(Scan)
                .filter(Scan.engagement_id == engagement_id)
                .order_by(Scan.started_at)
                .all()
            )
        ]

    return {
        "meta": meta,
        "audit": audit,
        "jobs_by_type": jobs_by_type,
        "jobs_count": sum(jobs_by_type.values()),
        "capture_paths": capture_paths,
        "scans": scans,
        "duration_s": duration_s,
        "ongoing": ongoing,
    }


def _report_stats(data: dict[str, Any], artifacts: list[dict[str, Any]]) -> dict[str, Any]:
    audit = data["audit"]
    violations = sum(1 for a in audit if a["kind"] == "scope.violation")
    targets = sorted({a["target"] for a in audit if a["target"]})
    evidence = [a for a in artifacts if a["category"] in _EVIDENCE_CATEGORIES]
    return {
        "audit_total": len(audit),
        "ops_submitted": data["jobs_count"],
        "ops_by_type": data["jobs_by_type"],
        "scope_violations": violations,
        "targets_engaged": len(targets),
        "scans_run": len(data["scans"]),
        "hosts_discovered": sum(sc["hosts_found"] or 0 for sc in data["scans"]),
        "captures_recorded": len(data["capture_paths"]),
        "evidence_artifacts": len(evidence),
        "duration": _fmt_duration(data["duration_s"], data["ongoing"]),
    }


def _build_report_markdown(
    data: dict[str, Any], stats: dict[str, Any], artifacts: list[dict[str, Any]],
    *, generated_at: str,
) -> tuple[str, list[str]]:
    meta = data["meta"]
    scope = meta["scope"]
    lines: list[str] = []
    sections: list[str] = []

    def h2(title: str) -> None:
        sections.append(title)
        lines.append(f"## {title}")
        lines.append("")

    lines.append(f"# Penetration Test Report — {meta['name']}")
    lines.append("")
    lines.append(
        "_Authorized engagement report generated by Warlock. "
        "Distribution limited to the authorizing client._"
    )
    lines.append("")

    # --- Engagement Summary -------------------------------------------------
    h2("Engagement Summary")
    lines.append("| Field | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Engagement | {_cell(meta['name'])} |")
    lines.append(f"| Engagement ID | `{_cell(meta['id'])}` |")
    lines.append(f"| Operator | {_cell(meta['operator'])} |")
    lines.append(f"| Status | {_cell(meta['status'])} |")
    lines.append(f"| Created (UTC) | {_fmt_dt(meta['created_at'])} |")
    lines.append(f"| Started (UTC) | {_fmt_dt(meta['started_at'])} |")
    lines.append(f"| Ended (UTC) | {_fmt_dt(meta['ended_at'])} |")
    lines.append(f"| Duration | {_cell(stats['duration'])} |")
    lines.append(f"| Report generated (UTC) | {_fmt_dt(generated_at)} |")
    lines.append("")

    # --- Authorization ------------------------------------------------------
    h2("Authorization")
    auth = meta["auth_statement"].strip()
    if auth:
        for ln in auth.splitlines():
            lines.append(f"> {ln}" if ln.strip() else ">")
    else:
        lines.append("_No authorization statement on file._")
    lines.append("")

    # --- Scope --------------------------------------------------------------
    h2("Scope")

    def _scope_block(label: str, key: str) -> None:
        items = [x for x in (scope.get(key) or []) if x]
        lines.append(f"**{label} ({len(items)}):**")
        lines.append("")
        if items:
            for it in items:
                lines.append(f"- `{_cell(it)}`")
        else:
            lines.append("- _none_")
        lines.append("")

    _scope_block("SSIDs", "ssids")
    _scope_block("BSSIDs", "bssids")
    _scope_block("IP ranges / CIDRs", "ip_ranges")
    if scope.get("planned_end"):
        lines.append(f"_Planned end:_ {_fmt_dt(scope.get('planned_end'))} (UTC)")
        lines.append("")

    # --- Findings & Artifacts ----------------------------------------------
    h2("Findings & Artifacts")
    lines.append(f"- **Audit events recorded:** {stats['audit_total']}")
    lines.append(f"- **Gated operations submitted:** {stats['ops_submitted']}")
    lines.append(f"- **Scope violations (refused):** {stats['scope_violations']}")
    lines.append(f"- **Distinct targets engaged:** {stats['targets_engaged']}")
    lines.append(f"- **Recon scans run:** {stats['scans_run']}")
    lines.append(f"- **Hosts discovered:** {stats['hosts_discovered']}")
    lines.append(f"- **Capture files produced:** {stats['captures_recorded']}")
    lines.append(f"- **Evidence artifacts on disk:** {stats['evidence_artifacts']}")
    lines.append("")

    if data["jobs_by_type"]:
        lines.append("### Operations by Type")
        lines.append("")
        lines.append("| Operation | Count |")
        lines.append("| --- | --- |")
        for t in sorted(data["jobs_by_type"]):
            lines.append(f"| {_cell(t)} | {data['jobs_by_type'][t]} |")
        lines.append("")

    if data["scans"]:
        lines.append("### Recon Scans")
        lines.append("")
        lines.append("| Started (UTC) | Target | Profile | Status | Hosts |")
        lines.append("| --- | --- | --- | --- | --- |")
        for sc in data["scans"]:
            lines.append(
                f"| {_fmt_dt(sc['started_at'])} | {_cell(sc['target'])} | "
                f"{_cell(sc['profile'])} | {_cell(sc['status'])} | {sc['hosts_found']} |"
            )
        lines.append("")

    if data["capture_paths"]:
        lines.append("### Capture Files")
        lines.append("")
        for cp in data["capture_paths"]:
            lines.append(f"- `{_cell(cp)}`")
        lines.append("")

    lines.append("### Engagement Artifacts on Disk")
    lines.append("")
    if artifacts:
        lines.append("| File | Category | Size |")
        lines.append("| --- | --- | --- |")
        for a in artifacts:
            lines.append(f"| `{_cell(a['name'])}` | {_cell(a['category'])} | {a['size_h']} |")
    else:
        lines.append("_No artifacts captured under the engagement directory._")
    lines.append("")

    # --- Operations Timeline ------------------------------------------------
    h2("Operations Timeline")
    if data["audit"]:
        lines.append("| # | Time (UTC) | Event | Target | Outcome | Note |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for i, a in enumerate(data["audit"], 1):
            lines.append(
                f"| {i} | {_fmt_dt(a['ts'])} | {_cell(a['kind'])} | "
                f"{_cell(a['target'])} | {_cell(a['outcome'])} | {_cell(a['note'])} |"
            )
    else:
        lines.append("_No gated operations were recorded for this engagement._")
    lines.append("")

    # --- Full Audit Trail ---------------------------------------------------
    h2("Full Audit Trail")
    lines.append(
        "Complete forensic record of every gated operation and policy decision, "
        "with the exact command and its SHA-256 fingerprint."
    )
    lines.append("")
    if data["audit"]:
        lines.append("| # | Time (UTC) | Kind | Outcome | SHA-256 | Command |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for i, a in enumerate(data["audit"], 1):
            sha = (a["sha256"] or "")[:16]
            lines.append(
                f"| {i} | {_fmt_dt(a['ts'])} | {_cell(a['kind'])} | "
                f"{_cell(a['outcome'])} | `{_cell(sha)}` | `{_cell(a['command'])}` |"
            )
    else:
        lines.append("_Audit log is empty for this engagement._")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(
        f"_Generated by Warlock ops module · engagement `{meta['id']}` · "
        f"{_fmt_dt(generated_at)} UTC._"
    )
    lines.append("")

    return "\n".join(lines), sections


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<style>
  :root {
    --bg: #0a0e0a; --tile: #0f140f; --line: #1d2a1d;
    --txt: #c8e6c9; --dim: #6f8f6f; --hi: #e8ffe8;
    --amber: #ffb000; --violet: #b794f6; --cyan: #5ee6d0; --pink: #ff5d8f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem; background: var(--bg); color: var(--txt);
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    font-size: 14px; line-height: 1.55; max-width: 1100px; margin-inline: auto;
  }
  h1 { color: var(--amber); border-bottom: 2px solid var(--amber); padding-bottom: .4rem; }
  h2 { color: var(--violet); margin-top: 2rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
  h3 { color: var(--cyan); margin-top: 1.4rem; }
  a { color: var(--cyan); }
  code { background: var(--tile); color: var(--hi); padding: .1rem .35rem; border-radius: 3px; font-size: .92em; }
  blockquote {
    margin: .5rem 0; padding: .5rem 1rem; border-left: 3px solid var(--cyan);
    background: var(--tile); color: var(--txt); white-space: pre-wrap;
  }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0; font-size: 13px; }
  th, td { border: 1px solid var(--line); padding: .4rem .6rem; text-align: left; vertical-align: top; }
  th { background: var(--tile); color: var(--amber); text-transform: uppercase; letter-spacing: .04em; font-size: 11px; }
  tr:nth-child(even) td { background: rgba(255,255,255,.015); }
  hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
  em { color: var(--dim); }
  @media print {
    body { background: #fff; color: #111; max-width: none; }
    h1 { color: #000; border-color: #000; }
    h2 { color: #1a1a1a; border-color: #999; }
    h3 { color: #333; }
    code { background: #f0f0f0; color: #000; }
    blockquote { background: #f7f7f7; color: #111; border-color: #666; }
    th { background: #eee; color: #000; }
    th, td { border-color: #999; }
    em { color: #555; }
  }
</style>
</head>
<body>
__BODY__
</body>
</html>
"""


def _render_html(markdown_src: str, *, title: str) -> str:
    try:
        from markdown_it import MarkdownIt

        body = MarkdownIt("commonmark").enable("table").render(markdown_src)
    except Exception as e:  # noqa: BLE001 — markdown-it absent / render failure
        log.warning("markdown render failed (%s); falling back to <pre>", e)
        body = "<pre>" + html_lib.escape(markdown_src) + "</pre>"
    return _HTML_TEMPLATE.replace("__TITLE__", html_lib.escape(title)).replace(
        "__BODY__", body
    )


def _generate_report(engagement_id: str, *, generated_at: str) -> dict[str, Any] | None:
    data = _report_core(engagement_id)
    if data is None:
        return None
    artifacts = _scan_artifacts(engagement_id)
    stats = _report_stats(data, artifacts)
    markdown_src, sections = _build_report_markdown(
        data, stats, artifacts, generated_at=generated_at
    )
    name = data["meta"]["name"]
    html = _render_html(markdown_src, title=f"Warlock Report — {name}")
    filename = f"warlock-report-{_slug(name)}-{engagement_id[:8]}"
    return {
        "ok": True,
        "engagement_id": engagement_id,
        "filename": filename,
        "generated_at": generated_at,
        "sections": sections,
        "stats": stats,
        "markdown": markdown_src,
        "html": html,
    }


class Module(ModuleBase):
    id = "ops"
    label = "Operations"
    icon = "◆"
    requires_engagement = False

    # Handle for the bus subscriber task; kept on the instance so re-creating
    # the app (e.g. across test modules) doesn't orphan a prior task.
    _bus_task: asyncio.Task[None] | None = None

    async def on_startup(self) -> None:
        """Start draining the alert bus into the activity-feed ring buffer."""
        if self._bus_task is None or self._bus_task.done():
            self._bus_task = asyncio.create_task(_consume_bus())

    async def on_shutdown(self) -> None:
        task = self._bus_task
        self._bus_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/ops", tags=[self.id])

        @r.get("/status")
        def ops_status() -> dict[str, Any]:
            st = engagement.status()
            return {
                "ok": True,
                "mode": st["mode"],
                "engagement_id": st["engagement_id"],
                "name": st["name"],
                "scope": st["scope"],
                "started_at": st["started_at"],
                "planned_end": st.get("planned_end"),
                "remaining_s": st.get("remaining_s"),
                "elapsed_s": _elapsed_s(engagement.started_at),
                "auth_statement": engagement.auth_statement if engagement.is_on() else "",
            }

        @r.post("/engagements", status_code=status.HTTP_201_CREATED)
        async def create_engagement(body: CreateEngagementBody) -> dict[str, Any]:
            _reject_placeholder_or_empty(body.targets)
            scope = _split_targets(body.targets)
            if not (scope.ssids or scope.bssids or scope.ip_ranges):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "targets must include at least one SSID / BSSID / IP / CIDR",
                )
            async with engagement_lock:
                if engagement.is_on():
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        "an engagement is already active — end it first",
                    )
                with session_scope() as s:
                    eng = Engagement(
                        name=body.name,
                        auth_statement=body.authorization,
                        scope=scope.to_dict(),
                        status="draft",
                    )
                    s.add(eng)
                    s.flush()
                    eid = eng.id
                try:
                    from datetime import datetime as _dt
                    planned_end_dt = _dt.utcnow() + timedelta(hours=body.duration_hours)
                    await engagement.activate(
                        name=body.name,
                        auth_statement=body.authorization,
                        scope=scope,
                        engagement_id=eid,
                        planned_end=planned_end_dt,
                    )
                except (RuntimeError, ValueError) as e:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

                with session_scope() as s:
                    row = s.get(Engagement, eid)
                    if row is not None:
                        row.status = "active"
                        row.started_at = engagement.started_at
                        # Store planned end as a hint in the scope JSON (best-effort).
                        planned_end = engagement.started_at + timedelta(
                            hours=body.duration_hours
                        ) if engagement.started_at else None
                        sc = dict(row.scope or {})
                        if planned_end:
                            sc["planned_end"] = planned_end.isoformat()
                        row.scope = sc
            return {
                "ok": True,
                "engagement_id": eid,
                "status": engagement.status(),
            }

        @r.post("/engagements/scope/add")
        async def add_scope(body: AddScopeBody) -> dict[str, Any]:
            """Authorize new targets on the active engagement, inline.

            Classifies ``targets`` the same way ``create_engagement`` does,
            rejects blank/placeholder tokens, then appends them to BOTH the live
            ``engagement`` singleton (the gate) and the persisted
            ``Engagement.scope`` row (reports/list) so the two stay consistent.
            """
            _reject_placeholder_or_empty(body.targets)
            delta = _split_targets(body.targets)
            if not (delta.ssids or delta.bssids or delta.ip_ranges):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "targets must include at least one SSID / BSSID / IP / CIDR",
                )
            async with engagement_lock:
                if not engagement.is_on():
                    raise HTTPException(
                        status.HTTP_409_CONFLICT, "no active engagement"
                    )
                try:
                    updated = engagement.add_scope_targets(delta)
                except RuntimeError as e:
                    raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
                # Keep the DB row consistent. The singleton's three lists are the
                # merged+deduped source of truth; overlay them onto the stored
                # scope so other keys (e.g. planned_end) survive.
                eid = engagement.engagement_id
                with session_scope() as s:
                    row = s.get(Engagement, eid)
                    if row is not None:
                        sc = dict(row.scope or {})
                        sc["ssids"] = list(updated.get("ssids", []))
                        sc["bssids"] = list(updated.get("bssids", []))
                        sc["ip_ranges"] = list(updated.get("ip_ranges", []))
                        row.scope = sc
            return {"ok": True, "added": delta.to_dict(), "scope": updated}

        @r.post("/engagements/end")
        async def end_engagement() -> dict[str, Any]:
            async with engagement_lock:
                eid = engagement.engagement_id
                if not engagement.is_on():
                    raise HTTPException(
                        status.HTTP_409_CONFLICT, "no active engagement"
                    )
                await engagement.end()
                with session_scope() as s:
                    row = s.get(Engagement, eid)
                    if row is not None:
                        row.status = "ended"
                        row.ended_at = datetime.utcnow()
            return {"ok": True, "engagement_id": eid}

        @r.get("/engagements")
        def list_engagements(limit: int = 50) -> dict[str, Any]:
            limit = max(1, min(500, int(limit)))
            with session_scope() as s:
                rows = (
                    s.query(Engagement)
                    .order_by(desc(Engagement.created_at))
                    .limit(limit)
                    .all()
                )
                out = [
                    {
                        "id": e.id,
                        "name": e.name,
                        "status": e.status,
                        "created_at": e.created_at.isoformat() if e.created_at else None,
                        "started_at": e.started_at.isoformat() if e.started_at else None,
                        "ended_at": e.ended_at.isoformat() if e.ended_at else None,
                        "scope": e.scope,
                        "targets_count": sum(
                            len((e.scope or {}).get(k, []))
                            for k in ("ssids", "bssids", "ip_ranges")
                        ),
                    }
                    for e in rows
                ]
            return {"ok": True, "engagements": out}

        @r.get("/engagements/{engagement_id}")
        def get_engagement(engagement_id: str) -> dict[str, Any]:
            with session_scope() as s:
                row = s.get(Engagement, engagement_id)
                if row is None:
                    raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
                detail = _engagement_detail_row(row)
            return {"ok": True, "engagement": detail}

        @r.post("/killswitch")
        async def killswitch() -> dict[str, Any]:
            result = await engagement.killswitch()
            return {"ok": True, **result}

        @r.get("/audit")
        def audit_log(since: str | None = None, limit: int = 50) -> dict[str, Any]:
            limit = max(1, min(500, int(limit)))
            with session_scope() as s:
                q = s.query(AuditEntry).order_by(desc(AuditEntry.ts))
                if since:
                    try:
                        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
                        q = q.filter(AuditEntry.ts >= since_dt.replace(tzinfo=None))
                    except ValueError:
                        pass
                rows = q.limit(limit).all()
                out = [
                    {
                        "id": a.id,
                        "ts": a.ts.isoformat() if a.ts else None,
                        "engagement_id": a.engagement_id,
                        "kind": a.kind,
                        "command": a.command,
                        "sha256": a.sha256,
                        "target": a.target,
                        "note": a.note,
                        "outcome": a.outcome,
                    }
                    for a in rows
                ]
            return {"ok": True, "audit": out, "count": len(out)}

        @r.get("/events")
        def ops_events(limit: int = 50, audit: int = 1) -> dict[str, Any]:
            """Live activity/loot feed — recent bus alerts + gated-op activity.

            Returns newest-first rows of ``{ts, source, severity, kind, text}``.
            ``audit=0`` returns only the bus alert ring (no DB folding).
            """
            limit = max(1, min(_FEED_MAX, int(limit)))
            feed = _build_feed(limit, include_audit=bool(audit))
            return {"ok": True, "events": feed, "count": len(feed)}

        @r.get("/engagements/{engagement_id}/report")
        def engagement_report(engagement_id: str) -> dict[str, Any]:
            report = _generate_report(
                engagement_id, generated_at=datetime.utcnow().isoformat()
            )
            if report is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "engagement not found")
            return report

        @r.post("/report")
        def post_report(body: ReportBody) -> dict[str, Any]:
            report = _generate_report(
                body.engagement_id, generated_at=datetime.utcnow().isoformat()
            )
            if report is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "engagement not found")
            return report

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.ops import OpsScreen

        return OpsScreen()
