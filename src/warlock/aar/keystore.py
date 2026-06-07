"""Ed25519 key custody for AAR signing.

A small ``KeyStore`` interface (file-backed today; a hardware/HSM backend can be
dropped in later without touching the signer). The file backend is a load-or-
create JWK keypair: generated ONCE if absent, written ``0600`` in a ``0700`` dir,
and NEVER regenerated if it exists — regenerating would invalidate every prior
signed record. Ed25519 ONLY (asymmetric); verifying a record must never grant the
power to forge one.
"""
from __future__ import annotations

import base64
import contextlib
import json
import os
from abc import ABC, abstractmethod
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from warlock.config import get_settings

_KEY_FILENAME = "ed25519.jwk.json"


def b64u(data: bytes) -> str:
    """base64url WITHOUT padding (matches Node's ``Buffer.toString('base64url')``
    and the JWK ``x``/``d`` convention the oracle's createPublicKey expects)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(s: str) -> bytes:
    """Decode unpadded (or padded) base64url."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


class KeyStore(ABC):
    """Signing-key backend. Implementations expose the private key for signing
    and the public key as a JWK for the did.json verification method."""

    @abstractmethod
    def private_key(self) -> Ed25519PrivateKey: ...

    @abstractmethod
    def public_raw(self) -> bytes: ...

    def public_jwk(self) -> dict:
        """OKP Ed25519 public JWK — the shape the did:web did.json embeds and the
        reference verifier loads via ``createPublicKey({format:'jwk'})``."""
        return {"kty": "OKP", "crv": "Ed25519", "x": b64u(self.public_raw())}


class FileKeyStore(KeyStore):
    """Ed25519 keypair persisted as an OKP JWK file (``0600``)."""

    def __init__(self, directory: Path) -> None:
        self.dir = Path(directory)
        self.path = self.dir / _KEY_FILENAME
        self._key: Ed25519PrivateKey | None = None

    def _load_or_create(self) -> Ed25519PrivateKey:
        if self._key is not None:
            return self._key
        if self.path.exists():
            data = json.loads(self.path.read_text())
            self._key = Ed25519PrivateKey.from_private_bytes(b64u_decode(data["d"]))
            return self._key
        # Generate ONCE. mkdir 0700, write 0600 — never overwrite an existing key.
        self.dir.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self.dir, 0o700)
        key = Ed25519PrivateKey.generate()
        raw_priv = key.private_bytes_raw()
        raw_pub = key.public_key().public_bytes_raw()
        jwk = {"kty": "OKP", "crv": "Ed25519", "x": b64u(raw_pub), "d": b64u(raw_priv)}
        # O_CREAT|O_EXCL → never clobber a key created concurrently between the
        # exists() check and here; if it lost the race, load the winner instead.
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            data = json.loads(self.path.read_text())
            self._key = Ed25519PrivateKey.from_private_bytes(b64u_decode(data["d"]))
            return self._key
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(jwk, fh)
        with contextlib.suppress(OSError):
            os.chmod(self.path, 0o600)
        self._key = key
        return key

    def private_key(self) -> Ed25519PrivateKey:
        return self._load_or_create()

    def public_raw(self) -> bytes:
        return self._load_or_create().public_key().public_bytes_raw()


# One FileKeyStore per directory (avoids re-reading the JWK on every emit while
# still picking up a different dir in tests that point WARLOCK_DATA elsewhere).
_STORES: dict[str, FileKeyStore] = {}


def get_keystore() -> KeyStore:
    d = get_settings().aar_keystore_dir()
    key = str(d)
    ks = _STORES.get(key)
    if ks is None:
        ks = FileKeyStore(d)
        _STORES[key] = ks
    return ks
