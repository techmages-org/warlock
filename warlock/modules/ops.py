"""Operations — engagement lifecycle module.

Exposes `/api/ops/*` endpoints that front the existing
``warlock.engagement.engagement`` singleton + SQLite-backed ``Engagement``
rows. The legacy ``/api/engagements/*`` router stays in place; ops is the
canonical module-facing surface (status, create+activate in one shot,
history, audit, killswitch).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import desc

from warlock.db import session_scope
from warlock.engagement import ScopeAllowlist, engagement, engagement_lock
from warlock.models import AuditEntry, Engagement, Job
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.ops")


class CreateEngagementBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    authorization: str = Field(..., min_length=1)
    targets: list[str] = Field(default_factory=list)
    duration_hours: float = Field(default=4.0, ge=0.25, le=24 * 14)


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


class Module(ModuleBase):
    id = "ops"
    label = "Operations"
    icon = "◆"
    requires_engagement = False

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
                "elapsed_s": _elapsed_s(engagement.started_at),
                "auth_statement": engagement.auth_statement if engagement.is_on() else "",
            }

        @r.post("/engagements", status_code=status.HTTP_201_CREATED)
        async def create_engagement(body: CreateEngagementBody) -> dict[str, Any]:
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
                    await engagement.activate(
                        name=body.name,
                        auth_statement=body.authorization,
                        scope=scope,
                        engagement_id=eid,
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

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.ops import OpsScreen

        return OpsScreen()
