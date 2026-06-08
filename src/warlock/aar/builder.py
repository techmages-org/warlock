"""Build, sign, and persist an AAR for an audit event.

``emit_for_audit`` maps an audit row (kind + command/target/note/outcome) to a
signed Agent Attestation Record, commits the evidence (the REAL engagement scope
state, not placeholders), stores the full preimage for custody, writes the signed
record, and advances the per-subject prior-chain.

``safe_emit_for_audit`` is the wrapper the audit write path calls: it NEVER raises
— a disabled subsystem, missing key dir, or signing error logs a warning and the
underlying audit write proceeds untouched.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from warlock.aar import preimage as preimage_mod
from warlock.aar import store
from warlock.aar.keystore import b64u, get_keystore
from warlock.aar.signer import canonicalize_record, sign
from warlock.config import get_settings
from warlock.engagement import engagement

log = logging.getLogger("warlock.aar")

# Audit kinds we attest. scope.violation + job.submit are the gated-action proofs;
# engagement.started/ended record the authorization lifecycle.
ATTESTED_KINDS = frozenset({"scope.violation", "job.submit", "engagement.started", "engagement.ended"})

_MODEL_BY_KIND = {
    "scope.violation": "warlock-scope-guard/0.1",
    "job.submit": "warlock-scope-guard/0.1",
    "engagement.started": "warlock-engagement/0.1",
    "engagement.ended": "warlock-engagement/0.1",
}


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _claim(kind: str, note: str, command: str) -> str:
    detail = note or command or kind
    if kind == "scope.violation":
        return f"attempted a gated op: {detail}"
    if kind == "job.submit":
        return f"submitted an in-scope gated op: {detail}"
    if kind == "engagement.started":
        return f"started an engagement: {detail}"
    if kind == "engagement.ended":
        return f"ended the engagement: {detail}"
    return detail


def _reason(kind: str, note: str, outcome: str) -> str:
    parts = [p for p in (outcome, note) if p]
    return ": ".join(parts) if parts else kind


def build_record(*, kind: str, command: str, target: str, note: str, outcome: str) -> tuple[dict, dict, str]:
    """Build the (unsigned) record, its preimage, and the task id.

    All signed-record fields are strings/bools (no numbers) so canonicalization
    cross-verifies with the reference tool. Numbers, if any, live only in the
    preimage (never canonicalized by the verifier)."""
    settings = get_settings()
    subject = settings.aar_subject_did
    observed_at = _now()

    # Evidence = the REAL engagement state/scope (authoritative source), not a
    # placeholder. This is what an authorized auditor recomputes from the preimage.
    query = f"engagement.check_target({target!r})" if target else "engagement.is_on()"
    response = {
        "engaged": engagement.is_on(),
        "engagement_id": engagement.engagement_id,
        "scope": engagement.scope.to_dict(),
        "target": target,
        "outcome": outcome,
        "command": command,
        "kind": kind,
    }
    preimage = {"query": query, "response": response, "observed_at": observed_at}
    rsha = preimage_mod.response_sha256(preimage)

    task_id = f"{kind}-{_stamp()}-{uuid4().hex[:8]}"
    # ground_truth: the engagement state IS the authoritative source we checked,
    # so the verdict is evidence-confirmed (never a silent pass).
    record: dict[str, Any] = {
        "aar": "0.02",
        "subject": subject,
        "principal": settings.aar_principal_did,
        "task": {"id": task_id, "claim": _claim(kind, note, command)},
        "verdict": "verified",
        "quality": "substantive",
        "ground_truth": "confirmed",
        "reason": _reason(kind, note, outcome),
        "checks": [
            {
                "source": "warlock://engagement/scope",
                "query": query,
                "observed_at": observed_at,
                "response_sha256": rsha,
                "excerpt": f"outcome={outcome}",
            }
        ],
        "verifier": {
            "id": subject,  # organizational (same_principal) self-attestation
            "model": _MODEL_BY_KIND.get(kind, "warlock-scope-guard/0.1"),
            "independence": "same_principal",
        },
        "issued": observed_at,
        # Non-signed annotation (dropped from the canonical payload) so the records
        # list can group by kind without parsing the task id.
        "_kind": kind,
    }
    prior = store.get_prior(subject)
    if prior:
        record["prior"] = prior  # L3 chain (forward-compat)
    from warlock.aar import grant as _grant
    gref = _grant.active_grant_ref()
    if gref:
        record["grant_ref"] = gref  # ties this attestation to the engagement grant (B3 scope binding)
    return record, preimage, task_id


def _attach_log(record: dict, task_id: str) -> None:
    """Best-effort L3: commit ``sha256(canonical(record))`` to the transparency log
    and embed the signed leaf receipt as ``record["log"]`` (then re-persist). The
    record is already signed; ``log`` is stripped by ``canonicalize_record`` so it
    is NOT part of the signed/committed preimage and the hash is stable whether or
    not the receipt is present. Offline-tolerant: a missing/unreachable log just
    leaves the record at L1 — never raises into the emit path."""
    import hashlib
    import json
    import urllib.request

    settings = get_settings()
    url = (settings.aar_log_url or "").strip()
    if not url:
        return
    h = b64u(hashlib.sha256(canonicalize_record(record)).digest())
    body = json.dumps({"hash": h}).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/"), data=body, headers={"content-type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=4) as r:  # noqa: S310 — operator-configured log URL
            if r.status not in (200, 201):
                return
            leaf = json.loads(r.read().decode())
    except Exception:  # noqa: BLE001 — L3 is additive + offline-tolerant
        log.warning("L3 log-attach failed (non-fatal); record stays L1", exc_info=True)
        return
    # Receipt: the logical log identity + the committed leaf (leaf_index/root/sig).
    record["log"] = {
        "host": settings.aar_log_host,
        "leaf_index": leaf.get("leaf_index"),
        "hash": leaf.get("hash"),
        "root": leaf.get("root"),
        "timestamp": leaf.get("timestamp"),
        "sig": leaf.get("sig"),
    }
    store.write_record(task_id, record)


def emit_for_audit(*, kind: str, command: str = "", target: str = "", note: str = "", outcome: str = "") -> str | None:
    """Build → sign → persist an AAR for one audit event. Returns the task id, or
    None when AAR is disabled or the kind is not attested. Raises on real errors
    (callers use ``safe_emit_for_audit`` to stay fail-safe)."""
    if not get_settings().aar_enabled:
        return None
    if kind not in ATTESTED_KINDS:
        return None
    record, preimage, task_id = build_record(
        kind=kind, command=command, target=target, note=note, outcome=outcome
    )
    keystore = get_keystore()
    subject = record["subject"]
    sign(record, keystore=keystore, by=subject)  # sign LAST
    preimage_mod.store_preimage(task_id, preimage)
    store.write_record(task_id, record)
    # L3: best-effort transparency-log commitment (embeds `log`, re-persists).
    _attach_log(record, task_id)
    # Advance the chain: next record from this subject carries this record's hash.
    # canonicalize_record strips `log`, so the prior hash is identical with or
    # without the receipt attached.
    import hashlib

    store.set_prior(subject, b64u(hashlib.sha256(canonicalize_record(record)).digest()))
    return task_id


def safe_emit_for_audit(**kwargs: Any) -> str | None:
    """Fail-safe entry point for the audit write path: never raises."""
    try:
        return emit_for_audit(**kwargs)
    except Exception:  # noqa: BLE001 — AAR is best-effort; never break the audit write
        log.warning("AAR emit failed (non-fatal): kind=%s", kwargs.get("kind"), exc_info=True)
        return None
