"""did:web DID document generation.

Produces the did.json the reference verifier resolves to get the signing public
key (it looks for ``verificationMethod[].publicKeyJwk``). Shape mirrors the
reference tool's keygen output so an offline ``--did-json`` verify AND online
``did:web`` resolution both work. The actual publish (to
``https://<host>/.well-known/did.json`` for a bare DID, or
``…/<path>/.well-known/did.json`` for a path-suffixed one) is an infra step.
"""
from __future__ import annotations

from warlock.aar.keystore import KeyStore, get_keystore
from warlock.config import get_settings


def did_document(subject_did: str, public_jwk: dict) -> dict:
    return {
        "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/suites/jws-2020/v1",
        ],
        "id": subject_did,
        "verificationMethod": [
            {
                "id": f"{subject_did}#key-1",
                "type": "JsonWebKey2020",
                "controller": subject_did,
                "publicKeyJwk": public_jwk,
            }
        ],
        "assertionMethod": [f"{subject_did}#key-1"],
    }


def deck_did_document(keystore: KeyStore | None = None) -> dict:
    """The deck's published did.json (subject DID + this deck's public key)."""
    ks = keystore or get_keystore()
    return did_document(get_settings().aar_subject_did, ks.public_jwk())
