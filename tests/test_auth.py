"""Tests for HTTP Basic auth + the /ws handshake authentication.

Covers the previously-untested auth surface:
  * ``warlock.auth.check_basic_auth`` — accept / reject / missing / disabled;
  * the HTTP middleware — 401 without creds, 200 with good creds, and
    /api/health + /api/version stay UNAUTHENTICATED;
  * the WebSocket bus — an unauthenticated /ws handshake is REJECTED (closed),
    and a handshake carrying the Basic credential is accepted (gets ws.hello).

Auth is toggled via ``WARLOCK_WEB_PASSWORD`` through the ``lru_cache``-backed
``get_settings`` — each app fixture sets it with ``monkeypatch.setenv`` and
clears the cache so there's no cross-module pollution (other suites run with an
empty password / auth disabled).
"""
from __future__ import annotations

import base64
import os
import tempfile

# Establish an auth-disabled baseline at import so monkeypatch.setenv restores to
# "" (matching the rest of the suite) rather than leaving auth enabled.
os.environ.setdefault("WARLOCK_DATA", tempfile.mkdtemp(prefix="warlock-auth-"))
os.environ.setdefault("WARLOCK_WEB_PASSWORD", "")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

USER = "warlock"
PASSWORD = "s3cr3t-pw"


def _basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


@pytest.fixture
def auth_client(monkeypatch, tmp_path):
    """TestClient with HTTP Basic auth ENABLED but /ws auth at its DEFAULT (OFF) —
    the shipping default, so the web event bus is not regressed."""
    monkeypatch.setenv("WARLOCK_DATA", str(tmp_path))
    monkeypatch.setenv("WARLOCK_WEB_USERNAME", USER)
    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", PASSWORD)
    monkeypatch.setenv("WARLOCK_WS_AUTH", "false")  # explicit: /ws enforcement OFF
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc
    get_settings.cache_clear()  # type: ignore[attr-defined] — let other suites rebuild


@pytest.fixture
def ws_auth_client(monkeypatch, tmp_path):
    """TestClient with HTTP Basic auth ENABLED and /ws enforcement turned ON
    (WARLOCK_WS_AUTH=1) — the staged, opt-in state."""
    monkeypatch.setenv("WARLOCK_DATA", str(tmp_path))
    monkeypatch.setenv("WARLOCK_WEB_USERNAME", USER)
    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", PASSWORD)
    monkeypatch.setenv("WARLOCK_WS_AUTH", "true")
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc
    get_settings.cache_clear()  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# Unit: check_basic_auth
# --------------------------------------------------------------------------- #
def test_check_basic_auth_accept_reject(monkeypatch):
    from warlock.config import get_settings

    monkeypatch.setenv("WARLOCK_WEB_USERNAME", USER)
    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", PASSWORD)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock import auth

    assert auth.auth_enabled() is True
    assert auth.check_basic_auth(_basic(USER, PASSWORD)) is True
    assert auth.check_basic_auth(_basic(USER, "wrong")) is False
    assert auth.check_basic_auth(_basic("nope", PASSWORD)) is False
    assert auth.check_basic_auth(None) is False
    assert auth.check_basic_auth("Bearer xyz") is False
    assert auth.check_basic_auth("Basic !!!not-base64!!!") is False
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_check_basic_auth_disabled_allows_all(monkeypatch):
    from warlock.config import get_settings

    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", "")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock import auth

    assert auth.auth_enabled() is False
    # With auth disabled, even a missing header is authorized (open LAN device).
    assert auth.check_basic_auth(None) is True
    get_settings.cache_clear()  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# HTTP middleware
# --------------------------------------------------------------------------- #
def test_http_rejects_without_credentials(auth_client):
    r = auth_client.get("/api/modules")
    assert r.status_code == 401
    assert r.headers.get("WWW-Authenticate") == "Basic"


def test_http_accepts_with_good_credentials(auth_client):
    r = auth_client.get("/api/modules", headers={"Authorization": _basic(USER, PASSWORD)})
    assert r.status_code == 200


def test_http_rejects_bad_password(auth_client):
    r = auth_client.get("/api/modules", headers={"Authorization": _basic(USER, "nope")})
    assert r.status_code == 401


def test_health_and_version_stay_unauthenticated(auth_client):
    # These must answer with NO credentials even while auth is enabled.
    assert auth_client.get("/api/health").status_code == 200
    assert auth_client.get("/api/version").status_code == 200


# --------------------------------------------------------------------------- #
# WebSocket /ws handshake
#
# Default (WARLOCK_WS_AUTH off): /ws does NOT enforce auth even while HTTP auth is
# on — preserves the browser event bus (no Authorization header possible). When
# flipped ON, /ws requires the same Basic credential as HTTP (the TUI sends it).
# --------------------------------------------------------------------------- #
def test_ws_open_by_default_no_regression(auth_client):
    # Flag OFF (shipping default) + HTTP auth ON: /ws still accepts with NO creds,
    # so the browser WS event bus keeps working.
    with auth_client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["name"] == "ws.hello"
        assert hello["payload"]["ok"] is True


def test_ws_rejects_unauthenticated_when_flag_on(ws_auth_client):
    with pytest.raises(WebSocketDisconnect):
        with ws_auth_client.websocket_connect("/ws"):
            pass


def test_ws_rejects_bad_credentials_when_flag_on(ws_auth_client):
    with pytest.raises(WebSocketDisconnect):
        with ws_auth_client.websocket_connect(
            "/ws", headers={"Authorization": _basic(USER, "nope")}
        ):
            pass


def test_ws_accepts_with_credentials_when_flag_on(ws_auth_client):
    with ws_auth_client.websocket_connect(
        "/ws", headers={"Authorization": _basic(USER, PASSWORD)}
    ) as ws:
        hello = ws.receive_json()
        assert hello["name"] == "ws.hello"
        assert hello["payload"]["ok"] is True


# --------------------------------------------------------------------------- #
# /ws signed token — the browser's header-free path. GET /api/ws-token (behind
# Basic auth) mints a short-lived HMAC token; /ws?token=… is accepted when the
# WS-auth flag is on.
# --------------------------------------------------------------------------- #
def test_ws_token_make_verify_round_trip(monkeypatch):
    from warlock.config import get_settings

    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", PASSWORD)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock import auth

    tok = auth.make_ws_token()
    assert auth.verify_ws_token(tok) is True
    # Expired (negative TTL), tampered, and empty tokens are all rejected.
    assert auth.verify_ws_token(auth.make_ws_token(ttl=-5)) is False
    assert auth.verify_ws_token(tok + "x") is False
    assert auth.verify_ws_token("not-a-token") is False
    assert auth.verify_ws_token(None) is False
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_ws_token_signature_is_password_bound(monkeypatch):
    """A token minted under one password must NOT verify under another."""
    from warlock.config import get_settings

    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", PASSWORD)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock import auth

    tok = auth.make_ws_token()
    monkeypatch.setenv("WARLOCK_WEB_PASSWORD", "different-pw")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    assert auth.verify_ws_token(tok) is False
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_ws_token_endpoint_requires_basic(auth_client):
    # No credentials -> 401 (the mint endpoint is Basic-auth-gated).
    assert auth_client.get("/api/ws-token").status_code == 401
    # With credentials -> a token + its TTL.
    r = auth_client.get("/api/ws-token", headers={"Authorization": _basic(USER, PASSWORD)})
    assert r.status_code == 200
    body = r.json()
    assert body["token"] and isinstance(body["token"], str)
    assert body["expires_in"] == 60


def test_ws_accepts_query_token_when_flag_on(ws_auth_client):
    # Browser flow: fetch a token (Basic), then connect with ?token=… (no header).
    tok = ws_auth_client.get(
        "/api/ws-token", headers={"Authorization": _basic(USER, PASSWORD)}
    ).json()["token"]
    with ws_auth_client.websocket_connect(f"/ws?token={tok}") as ws:
        hello = ws.receive_json()
        assert hello["name"] == "ws.hello"
        assert hello["payload"]["ok"] is True


def test_ws_rejects_bad_query_token_when_flag_on(ws_auth_client):
    with pytest.raises(WebSocketDisconnect):
        with ws_auth_client.websocket_connect("/ws?token=garbage"):
            pass
