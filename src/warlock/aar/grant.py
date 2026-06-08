"""Engagement-as-Grant (Track B / B3).

When an engagement is armed, mint a **principal-signed `acp_grant`** — "this console may operate
within scope X until time T" — and stamp its `grant_id` onto every AAR as `grant_ref`. The grant is
the AAR spec's scope-binding primitive (spec §9): it makes "did the deck stay in bounds?" verifiable
by a third party against the same engagement scope the gate already enforces.

The principal key (`<keys>/principal/ed25519.jwk.json`, 0600) signs the grant — distinct from the
deck's subject key that signs AARs. Single-deck simplification: the principal key lives on the deck;
in a multi-deck deployment it would live in the org control plane.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from warlock.aar.keystore import FileKeyStore, KeyStore
from warlock.aar.signer import sign
from warlock.config import get_settings

log = logging.getLogger("warlock.aar.grant")

_active_grant_ref: str | None = None
_principal_ks: KeyStore | None = None


def principal_keystore() -> KeyStore:
    global _principal_ks
    if _principal_ks is None:
        _principal_ks = FileKeyStore(get_settings().aar_keystore_dir() / "principal")
    return _principal_ks


def _grants_dir() -> Path:
    d = get_settings().data / "grants"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _scope_to_grant(scope: Any) -> dict[str, list[str]]:
    """ScopeAllowlist (ssids / bssids / ip_ranges) → acp_grant scope shape."""
    hosts: list[str] = []
    subnets: list[str] = []
    for r in (getattr(scope, "ip_ranges", None) or []):
        (subnets if "/" in r else hosts).append(r)
    return {"hosts": hosts, "subnets": subnets,
            "ssids": list(getattr(scope, "ssids", None) or []),
            "bssids": list(getattr(scope, "bssids", None) or [])}


def mint_grant(*, engagement_id: str, scope: Any, name: str = "", ttl_hours: int = 24) -> dict | None:
    """Build + principal-sign an acp_grant for the engagement; set it active. Best-effort
    (never breaks engagement arming — a missing principal key just means no grant_ref)."""
    global _active_grant_ref
    s = get_settings()
    now = datetime.utcnow()
    grant = {
        "acp_grant": "0.1",
        "grant_id": engagement_id,
        "subject": s.aar_subject_did,
        "principal": s.aar_principal_did,
        "scope": _scope_to_grant(scope),
        "policy": name or "engagement",
        "issued": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "not_after": (now + timedelta(hours=ttl_hours)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    try:
        sign(grant, keystore=principal_keystore(), by=s.aar_principal_did)
        (_grants_dir() / f"{engagement_id}.json").write_text(json.dumps(grant, indent=2))
        _active_grant_ref = engagement_id
        log.info("minted grant %s (scope %s)", engagement_id, grant["scope"])
        return grant
    except Exception:  # noqa: BLE001 — grant is additive; arming must not fail on it
        log.warning("grant mint failed (non-fatal); AARs will carry no grant_ref", exc_info=True)
        return None


def active_grant_ref() -> str | None:
    return _active_grant_ref


def get_grant(grant_id: str) -> dict | None:
    p = _grants_dir() / f"{grant_id}.json"
    try:
        return json.loads(p.read_text()) if p.exists() else None
    except OSError:
        return None


def clear_active() -> None:
    global _active_grant_ref
    _active_grant_ref = None
