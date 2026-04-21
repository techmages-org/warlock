"""Engagement lifecycle HTTP API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from warlock.db import session_scope
from warlock.engagement import ScopeAllowlist, engagement, engagement_lock
from warlock.models import Engagement

router = APIRouter(prefix="/api/engagements", tags=["engagements"])


class ScopeIn(BaseModel):
    ssids: list[str] = []
    bssids: list[str] = []
    ip_ranges: list[str] = []


class EngagementIn(BaseModel):
    name: str
    auth_statement: str
    scope: ScopeIn


@router.get("")
def list_engagements() -> list[dict]:
    with session_scope() as s:
        rows = s.query(Engagement).order_by(Engagement.created_at.desc()).limit(100).all()
        return [
            {
                "id": r.id,
                "name": r.name,
                "status": r.status,
                "created_at": r.created_at.isoformat(),
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
            }
            for r in rows
        ]


@router.get("/active")
def active() -> dict:
    return engagement.status()


@router.post("", status_code=status.HTTP_201_CREATED)
def create(body: EngagementIn) -> dict:
    with session_scope() as s:
        e = Engagement(
            name=body.name,
            auth_statement=body.auth_statement,
            scope=body.scope.model_dump(),
            status="draft",
        )
        s.add(e)
        s.flush()
        eid = e.id
    return {"id": eid, "status": "draft"}


@router.post("/{engagement_id}/activate")
async def activate(engagement_id: str) -> dict:
    async with engagement_lock:
        with session_scope() as s:
            row = s.get(Engagement, engagement_id)
            if row is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "engagement not found")
            scope = ScopeAllowlist(**row.scope) if isinstance(row.scope, dict) else ScopeAllowlist()
            name = row.name
            auth = row.auth_statement

        await engagement.activate(
            name=name, auth_statement=auth, scope=scope, engagement_id=engagement_id
        )

        with session_scope() as s:
            row = s.get(Engagement, engagement_id)
            if row is not None:
                row.status = "active"
                row.started_at = engagement.started_at
    return engagement.status()


@router.post("/{engagement_id}/end")
async def end(engagement_id: str) -> dict:
    async with engagement_lock:
        if engagement.engagement_id != engagement_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "not the active engagement")
        await engagement.end()
        with session_scope() as s:
            row = s.get(Engagement, engagement_id)
            if row is not None:
                row.status = "ended"
                from datetime import datetime

                row.ended_at = datetime.utcnow()
    return {"ok": True}


@router.post("/killswitch")
async def killswitch() -> dict:
    result = await engagement.killswitch()
    return result
