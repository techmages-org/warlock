"""AAR (Agent Attestation Record) — Ed25519-signed, JCS-canonicalized, did:web
identified proofs emitted alongside Warlock's audit rows.

Ed25519 only (asymmetric signatures); there are no symmetric MACs in this path —
verifying a record must never confer the power to forge one.
"""
from __future__ import annotations

from warlock.aar.builder import (
    ATTESTED_KINDS,
    build_record,
    emit_for_audit,
    safe_emit_for_audit,
)
from warlock.aar.did import deck_did_document, did_document
from warlock.aar.keystore import KeyStore, get_keystore
from warlock.aar.signer import canonicalize_record, sign, verify

__all__ = [
    "ATTESTED_KINDS",
    "build_record",
    "emit_for_audit",
    "safe_emit_for_audit",
    "deck_did_document",
    "did_document",
    "KeyStore",
    "get_keystore",
    "canonicalize_record",
    "sign",
    "verify",
]
