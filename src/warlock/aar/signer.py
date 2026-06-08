"""Canonicalization + Ed25519 signing/verification for AAR records.

Canonicalization is the interop-critical part. The signed payload is the record
with the ``sig`` field and any ``_``-prefixed annotation removed (recursively),
serialized via JCS (RFC 8785) as UTF-8 bytes. We use the ``rfc8785`` library
(not a hand-rolled serializer); for AAR's all-string/enum/bool records this is
proven byte-identical to the reference verifier's canonicalizer, so signatures
cross-verify.

Ed25519 ONLY. The signature is over the canonical bytes; ``sig.value`` is
base64url (unpadded). There are no symmetric MACs in this path — verifying must
never confer the ability to forge.
"""
from __future__ import annotations

from typing import Any

import rfc8785
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from warlock.aar.keystore import KeyStore, b64u, b64u_decode


def _strip(value: Any) -> Any:
    """Recursively drop the ``sig`` field, the ``log`` L3 receipt, and any
    ``_``-prefixed annotation at every level. ``log`` is stripped for the same
    reason as ``sig``: the transparency-log receipt is attached AFTER signing
    (it commits ``sha256(canonical(record))``, which can't exist until the
    record is signed), so it must not be part of the signed/committed preimage.
    Stripping it is a no-op on pre-L3 records, so existing signatures still
    verify. Mirrors the verify.html / acp-ingest strip exactly."""
    if isinstance(value, list):
        return [_strip(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in value.items() if k not in ("sig", "log") and not k.startswith("_")}
    return value


def canonicalize_record(record: dict) -> bytes:
    """Signed-payload bytes: strip ``sig``/``_`` keys, then JCS (RFC 8785)."""
    return rfc8785.dumps(_strip(record))


def canonical_bytes(obj: Any) -> bytes:
    """JCS (RFC 8785) bytes of an arbitrary object — used for the evidence
    preimage (no ``sig``/``_`` stripping; a preimage is not a record)."""
    return rfc8785.dumps(obj)


def sign(record: dict, *, keystore: KeyStore, by: str) -> dict:
    """Sign ``record`` in place: canonicalize → Ed25519 sign → attach
    ``sig = {alg:'Ed25519', by:<did>, value:<base64url>}``. Returns the record.

    Caller MUST have populated every signed field (checks, verifier, prior, …)
    BEFORE calling — anything added after signing breaks verification."""
    message = canonicalize_record(record)
    signature = keystore.private_key().sign(message)
    record["sig"] = {"alg": "Ed25519", "by": by, "value": b64u(signature)}
    return record


def verify(record: dict, public_jwk: dict) -> bool:
    """Pure-Python self-verify against an OKP public JWK (the same key the
    did.json publishes). Returns False on any malformed/forged input."""
    sig = record.get("sig") or {}
    if sig.get("alg") != "Ed25519" or not sig.get("value"):
        return False
    try:
        pub = Ed25519PublicKey.from_public_bytes(b64u_decode(public_jwk["x"]))
        pub.verify(b64u_decode(sig["value"]), canonicalize_record(record))
        return True
    except (InvalidSignature, KeyError, ValueError):
        return False
