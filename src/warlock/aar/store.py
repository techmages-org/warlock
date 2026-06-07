"""On-disk store for signed AAR records + the per-subject prior-hash chain.

Records land under ``<data>/aar/records/`` (one JSON per task id). The chain
state (``<data>/aar/chain/<subject>.hash``) holds the base64url SHA-256 of the
last record's canonical bytes for each subject, so the next record can carry it
as ``prior`` (L3 tamper-evidence; the current reference verifier does not yet
validate it, but we carry the chain for forward-compat).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from warlock.config import get_settings


def _records_dir() -> Path:
    p = get_settings().aar_dir() / "records"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _chain_dir() -> Path:
    p = get_settings().aar_dir() / "chain"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _slug(did: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", did) or "subject"


def write_record(task_id: str, record: dict) -> Path:
    path = _records_dir() / f"{task_id}.json"
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return path


def list_records() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in sorted(_records_dir().glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({
            "task_id": p.stem,
            "subject": rec.get("subject"),
            "kind": (rec.get("_kind") or rec.get("task", {}).get("id", "").split("-")[0]),
            "verdict": rec.get("verdict"),
            "ground_truth": rec.get("ground_truth"),
            "issued": rec.get("issued"),
        })
    out.sort(key=lambda r: r.get("issued") or "", reverse=True)
    return out


def get_record(task_id: str) -> dict[str, Any] | None:
    path = _records_dir() / f"{task_id}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# --- prior-hash chain (per subject) --------------------------------------- #
def get_prior(subject: str) -> str | None:
    """The base64url hash of the previous record from ``subject`` (or None)."""
    path = _chain_dir() / f"{_slug(subject)}.hash"
    try:
        v = path.read_text(encoding="utf-8").strip()
        return v or None
    except OSError:
        return None


def set_prior(subject: str, prior_hash: str) -> None:
    (_chain_dir() / f"{_slug(subject)}.hash").write_text(prior_hash, encoding="utf-8")
