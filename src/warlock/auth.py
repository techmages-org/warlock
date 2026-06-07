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
import secrets

from warlock.config import get_settings


def auth_enabled() -> bool:
    """True when HTTP Basic auth is enforced (a non-empty web password is set)."""
    return bool(get_settings().web_password)


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
