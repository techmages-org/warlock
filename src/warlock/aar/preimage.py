"""Evidence preimage custody.

The portable record carries only ``response_sha256`` — a base64url SHA-256 over
the canonical preimage ``{query, response, observed_at}``. The FULL preimage is
retained on local disk (keyed by ``task.id``) and disclosed only to an authorized
party, who re-runs/re-hashes it to confirm the verdict without trusting the
signer. The preimage may contain secrets/PII, so it travels point-to-point — only
the hash is in the portable record.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from warlock.aar.keystore import b64u
from warlock.aar.signer import canonical_bytes
from warlock.config import get_settings


def _preimages_dir() -> Path:
    p = get_settings().aar_dir() / "preimages"
    p.mkdir(parents=True, exist_ok=True)
    return p


def response_sha256(preimage: dict) -> str:
    """base64url( SHA-256( JCS(preimage) ) ) — the evidence commitment."""
    return b64u(hashlib.sha256(canonical_bytes(preimage)).digest())


def store_preimage(task_id: str, preimage: dict) -> Path:
    """Persist the full preimage (the custody artifact). Never shipped in the
    portable record."""
    path = _preimages_dir() / f"{task_id}.json"
    path.write_text(json.dumps(preimage, indent=2), encoding="utf-8")
    return path


def load_preimage(task_id: str) -> dict[str, Any] | None:
    path = _preimages_dir() / f"{task_id}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
