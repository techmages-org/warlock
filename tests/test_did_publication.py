"""Tests for DID document publication and .well-known resolution paths."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """Warlock app with a temp keystore so we don't clobber the real Ed25519 key."""
    monkeypatch.setenv("WARLOCK_DATA_DIR", str(tmp_path))
    # Must import after env var is set.
    from warlock.server import create_app
    app = create_app()
    return TestClient(app)


def test_well_known_did_json_serves_document(client):
    """The bare /.well-known/did.json path returns a valid DID document."""
    r = client.get("/.well-known/did.json")
    assert r.status_code == 200
    doc = r.json()
    assert "@context" in doc
    assert doc["id"].startswith("did:web:")
    vm = doc["verificationMethod"][0]
    assert vm["type"] == "JsonWebKey2020"
    assert "publicKeyJwk" in vm
    jwk = vm["publicKeyJwk"]
    assert jwk["kty"] == "OKP"
    assert jwk["crv"] == "Ed25519"
    assert "x" in jwk  # public key present


def test_well_known_did_json_no_auth_required(client):
    """DID document must be fetchable without Basic auth."""
    r = client.get("/.well-known/did.json")
    assert r.status_code == 200
    assert "WWW-Authenticate" not in r.headers


def test_path_suffixed_did_json_serves_document(client):
    """The path-suffixed DID route works when deck_id matches the DID subject."""
    # Extract the expected deck_id from the DID subject.
    r = client.get("/.well-known/did.json")
    did = r.json()["id"]
    deck_id = did.split(":")[-1]  # e.g. "warlock-cm5-01"
    r2 = client.get(f"/{deck_id}/.well-known/did.json")
    assert r2.status_code == 200
    assert r2.json()["id"] == did


def test_wrong_deck_id_returns_404(client):
    """A random deck_id must NOT leak the deck's DID document."""
    r = client.get("/totally-wrong-deck/.well-known/did.json")
    assert r.status_code == 404


def test_did_document_has_assertion_method(client):
    """The DID document must list assertionMethod for AAR verification."""
    r = client.get("/.well-known/did.json")
    doc = r.json()
    assert "assertionMethod" in doc
    assert len(doc["assertionMethod"]) >= 1
    assert doc["assertionMethod"][0].endswith("#key-1")
