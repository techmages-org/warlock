"""AAR read API — all behind the app's HTTP Basic auth.

Lets an authorized auditor list/fetch signed records, fetch the FULL evidence
preimage (custody disclosure) to recompute a check's hash, and fetch the deck's
did.json (the public key the records verify against).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from warlock.config import get_settings

router = APIRouter(prefix="/api/aar", tags=["aar"])


class PushIn(BaseModel):
    ingest_url: str
    grant_ref: str | None = None


@router.get("/status")
def status() -> dict[str, Any]:
    s = get_settings()
    from warlock.aar import store

    return {
        "ok": True,
        "enabled": s.aar_enabled,
        "subject": s.aar_subject_did,
        "principal": s.aar_principal_did,
        "log_host": s.aar_log_host,
        "records": len(store.list_records()),
    }


@router.get("/did.json")
def did_json() -> dict[str, Any]:
    """The deck's DID document (public key). Publish a copy at the subject's
    did:web ``/.well-known/did.json`` so records resolve online."""
    from warlock.aar import deck_did_document

    return deck_did_document()


@router.get("/records")
def records() -> dict[str, Any]:
    from warlock.aar import store

    rows = store.list_records()
    return {"ok": True, "records": rows, "count": len(rows)}


@router.get("/records/{task_id}")
def record(task_id: str) -> dict[str, Any]:
    from warlock.aar import store

    rec = store.get_record(task_id)
    if rec is None:
        raise HTTPException(404, "record not found")
    return rec


@router.post("/push")
def push(body: PushIn) -> dict[str, Any]:
    """Roll the active engagement's AARs + a report/manifest UP to an ingest server
    (Track B / B4). Each upload is console-signed (acp-signature). The server gates
    on enrollment + grant — an enrolled console with a valid in-scope grant_ref gets
    202; a revoked/unenrolled console or missing grant is refused (and logged)."""
    from warlock.aar import producer

    return producer.push_engagement(ingest_url=body.ingest_url, grant_ref=body.grant_ref)


@router.get("/preimage/{task_id}")
def preimage(task_id: str) -> dict[str, Any]:
    """The full evidence preimage for a record's check — the custody disclosure an
    authorized auditor recomputes ``response_sha256`` from."""
    from warlock.aar import preimage as preimage_mod

    pre = preimage_mod.load_preimage(task_id)
    if pre is None:
        raise HTTPException(404, "preimage not found")
    return {"ok": True, "task_id": task_id, "preimage": pre}
