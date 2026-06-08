"""Deck Producer (Track B / B4).

Roll an engagement into a signed bundle and push it UP to the ingest server:

  - each AAR for the engagement's grant  → POST /v1/aars
  - a structured engagement report + payload manifest → POST /v1/reports

Every upload is signed with the **console** Ed25519 key (the `acp-signature` header — the identity is
the auth, no shared secret). The server's gate decides: an enrolled console with a valid in-scope
grant_ref gets 202; an unenrolled/revoked console or a missing/expired grant gets refused. Payload
*blobs* are not shipped by default (opt-in, with retention) — the report carries a manifest (names +
sizes + hashes) so the control plane knows what exists without the deck leaking captures.
"""
from __future__ import annotations

import hashlib
import json
import logging
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any

from warlock.aar import grant as grantmod
from warlock.aar import store
from warlock.aar.keystore import b64u, get_keystore
from warlock.config import get_settings

log = logging.getLogger("warlock.aar.producer")


def _sha256b64u(b: bytes) -> str:
    return b64u(hashlib.sha256(b).digest())


def _console_sign_header(body: bytes) -> str:
    """acp-signature header: <console-did> <b64u(ed25519_sign(utf8(sha256b64u(body))))>."""
    ks = get_keystore()
    did = get_settings().aar_subject_did
    sig = ks.private_key().sign(_sha256b64u(body).encode("utf-8"))
    return f"{did} {b64u(sig)}"


def _post(url: str, body: bytes, grant_ref: str | None = None) -> tuple[int, str]:
    headers = {"content-type": "application/json", "acp-signature": _console_sign_header(body)}
    if grant_ref:
        headers["acp-grant-ref"] = grant_ref
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 — operator-supplied ingest URL
            return r.status, r.read().decode(errors="replace")[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]
    except OSError as e:
        return 0, str(e)[:200]


def _payload_manifest() -> list[dict[str, Any]]:
    s = get_settings()
    manifest: list[dict[str, Any]] = []
    for sub in ("captures", "loot", "handshakes"):
        d = s.data / sub
        if not d.exists():
            continue
        for f in sorted(d.glob("**/*")):
            if f.is_file():
                manifest.append({"name": f"{sub}/{f.name}", "bytes": f.stat().st_size})
    return manifest[:500]


def push_engagement(*, ingest_url: str, grant_ref: str | None = None) -> dict[str, Any]:
    """Push every AAR for the engagement's grant + a report/manifest to the ingest server."""
    s = get_settings()
    gref = grant_ref or grantmod.active_grant_ref()
    if not gref:
        return {"ok": False, "error": "no active grant_ref — arm an engagement first"}
    base = ingest_url.rstrip("/")

    aars: list[dict[str, Any]] = []
    for row in store.list_records():
        rec = store.get_record(row["task_id"])
        if not rec or rec.get("grant_ref") != gref:
            continue
        body = json.dumps(rec).encode("utf-8")
        code, _msg = _post(f"{base}/v1/aars", body, grant_ref=gref)
        aars.append({"task_id": rec.get("task", {}).get("id"), "status": code})

    manifest = _payload_manifest()
    report = {
        "report": "engagement", "engagement_id": gref, "grant_ref": gref,
        "subject": s.aar_subject_did, "principal": s.aar_principal_did,
        "generated": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "aars": [a["task_id"] for a in aars],
        "payload_manifest": manifest,
        "summary": {"aar_count": len(aars), "payload_count": len(manifest)},
    }
    rcode, rmsg = _post(f"{base}/v1/reports", json.dumps(report).encode("utf-8"), grant_ref=gref)
    accepted = sum(1 for a in aars if a["status"] == 202)
    return {"ok": True, "grant_ref": gref, "ingest": base,
            "aars_pushed": len(aars), "aars_accepted": accepted, "aars": aars,
            "report_status": rcode, "report_msg": rmsg if rcode != 202 else None,
            "manifest_count": len(manifest)}
