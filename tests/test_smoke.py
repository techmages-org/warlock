"""Smoke test — does the server come up and answer /api/health + /api/version?"""
from __future__ import annotations

import os
import tempfile

# Keep the default password empty so the test client doesn't need basic auth.
os.environ.setdefault("WARLOCK_WEB_PASSWORD", "")

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    # Isolate data dir so we don't stomp on the real one.
    tmp = tempfile.mkdtemp(prefix="warlock-test-")
    os.environ["WARLOCK_DATA"] = tmp
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    from warlock.server import create_app

    with TestClient(create_app()) as tc:
        yield tc


def test_health(client) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True


def test_version(client) -> None:
    r = client.get("/api/version")
    assert r.status_code == 200
    assert r.json()["name"] == "warlock"


def test_modules_list(client) -> None:
    r = client.get("/api/modules")
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()]
    # Canonical tab order includes these:
    for needed in ("dashboard", "mesh", "gps", "ops", "system"):
        assert needed in ids


def test_engagements_active_defaults_off(client) -> None:
    r = client.get("/api/engagements/active")
    assert r.status_code == 200
    assert r.json()["mode"] == "off"
