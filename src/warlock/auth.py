"""Shared HTTP Basic auth verification.

Single source of truth for credential checking, used by BOTH the HTTP middleware
(``server._check_auth``) and the WebSocket handshake (``api.ws``) so the ``/ws``
event bus is protected by the exact same credential as every HTTP endpoint.

Reads ``get_settings()`` fresh on each call (it is ``lru_cache``-backed, so this
is cheap) rather than capturing a module-level snapshot — this keeps the check in
lock-step with the current settings and makes auth state controllable in tests.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

from warlock.config import get_settings

# Short-lived signed token for the browser /ws handshake. The WebSocket API
# cannot set an Authorization header, so the web client first fetches a token
# from GET /api/ws-token (behind Basic auth) and passes it as ?token=… on the
# /ws upgrade. The token is an opaque, HMAC-signed, time-boxed blob keyed by the
# web password — no server-side session state is needed to verify it.
WS_TOKEN_TTL = 60  # seconds


def auth_enabled() -> bool:
    """True when HTTP Basic auth is enforced (a non-empty web password is set)."""
    return bool(get_settings().web_password)


def _ws_token_key() -> bytes:
    """HMAC signing key for /ws tokens (the configured web password)."""
    return get_settings().web_password.encode("utf-8")


def make_ws_token(ttl: int = WS_TOKEN_TTL) -> str:
    """Mint an opaque, HMAC-signed /ws token that expires in ``ttl`` seconds.

    Format (before base64url): ``"<exp>:<hex-hmac-sha256(exp)>"`` where ``exp``
    is the absolute unix expiry. The whole thing is urlsafe-base64-encoded so it
    drops cleanly into a ``?token=`` query param. ``ttl`` may be negative — used
    by tests to produce an already-expired token.
    """
    exp = int(time.time()) + int(ttl)
    sig = hmac.new(_ws_token_key(), str(exp).encode("ascii"), hashlib.sha256).hexdigest()
    raw = f"{exp}:{sig}".encode("ascii")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def verify_ws_token(token: str | None) -> bool:
    """Return True if ``token`` is a well-formed, unexpired, correctly-signed
    /ws token for the current web password. Any malformed/expired/forged token
    (or ``None``) returns False — never raises."""
    if not token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii")).decode("ascii")
        exp_str, sep, sig = raw.partition(":")
        if not sep:
            return False
        exp = int(exp_str)
    except Exception:  # noqa: BLE001 — any malformed token is simply unauthorized
        return False
    if exp < int(time.time()):
        return False
    expected = hmac.new(
        _ws_token_key(), str(exp).encode("ascii"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(sig, expected)


def check_basic_auth(authorization: str | None) -> bool:
    """Return True if the request is authorized.

    When auth is disabled (empty ``web_password``) this always returns True so
    the deck stays open on a trusted LAN exactly as before. Otherwise the
    ``Authorization`` header must carry a valid HTTP Basic credential. The
    comparison is constant-time on both username and password.
    """
    settings = get_settings()
    if not settings.web_password:
        return True
    if not authorization or not authorization.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(authorization.split(" ", 1)[1]).decode(
            "utf-8", errors="replace"
        )
    except Exception:  # noqa: BLE001 — any malformed header is simply unauthorized
        return False
    username, _, password = decoded.partition(":")
    ok_user = secrets.compare_digest(username, settings.web_username)
    ok_pass = secrets.compare_digest(password, settings.web_password)
    return ok_user and ok_pass
