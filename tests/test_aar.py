"""Tests for the AAR (Agent Attestation Record) package.

Two layers of conformance:
  * pure-Python self-verification (canonicalize → Ed25519 verify, custody hash
    recompute FROM DISK, tamper-evidence) — always runs;
  * the reference oracle (``node tools/aar.mjs verify``) — the cross-verify gate.
    It RUNS when node + the vendored oracle are present (asserting the build FAILS
    on a non-conformant record) and SKIPS (loudly) only when genuinely absent.

Ed25519 only — the package contains no symmetric MACs (asserted below).
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

# Disable basic-auth before importing warlock so the test client is open.
os.environ.setdefault("WARLOCK_WEB_PASSWORD", "")

AAR_PKG = Path(__file__).resolve().parents[1] / "src" / "warlock" / "aar"


@pytest.fixture
def aar_env(tmp_path, monkeypatch):
    """Point WARLOCK_DATA + the keystore dir at a fresh tmp tree and rebuild
    settings, so keys/records/preimages stay hermetic."""
    monkeypatch.setenv("WARLOCK_DATA", str(tmp_path))
    monkeypatch.setenv("WARLOCK_AAR_KEYS_DIR", str(tmp_path / "keys"))
    monkeypatch.setenv("WARLOCK_AAR", "1")
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield tmp_path
    get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest.fixture(autouse=True)
def _engagement_off():
    from warlock.engagement import ScopeAllowlist, engagement

    def _off():
        engagement._mode = "off"
        engagement.engagement_id = None
        engagement.scope = ScopeAllowlist()
        engagement.audit_log_path = None

    _off()
    yield
    _off()


def _engage():
    from datetime import datetime

    from warlock.engagement import ScopeAllowlist, engagement

    engagement._mode = "on"
    engagement.engagement_id = "eng-aar-test"
    engagement.scope = ScopeAllowlist(ip_ranges=["10.0.0.0/24"], bssids=["aa:bb:cc:dd:ee:ff"])
    engagement.started_at = datetime.utcnow()
    engagement.audit_log_path = None


def _find_oracle() -> str | None:
    if shutil.which("node") is None:
        return None
    cands = [
        os.environ.get("WARLOCK_AAR_ORACLE"),
        "vendor/acp/tools/aar.mjs",
        "/tmp/acp-oracle/tools/aar.mjs",
    ]
    for c in cands:
        if c and Path(c).is_file():
            return c
    return None


# --------------------------------------------------------------------------- #
# Keystore
# --------------------------------------------------------------------------- #
def test_keystore_load_or_create_and_perms(aar_env):
    from warlock.aar.keystore import FileKeyStore

    ks = FileKeyStore(aar_env / "keys")
    pub1 = ks.public_raw()
    assert len(pub1) == 32  # Ed25519 public key
    assert ks.path.exists()
    # 0600 file perms.
    mode = stat.S_IMODE(ks.path.stat().st_mode)
    assert mode == 0o600, oct(mode)
    # A fresh store over the same dir loads the SAME key (never regenerated).
    pub2 = FileKeyStore(aar_env / "keys").public_raw()
    assert pub1 == pub2


def test_public_jwk_is_okp_unpadded(aar_env):
    from warlock.aar.keystore import FileKeyStore

    jwk = FileKeyStore(aar_env / "keys").public_jwk()
    assert jwk["kty"] == "OKP" and jwk["crv"] == "Ed25519"
    assert "=" not in jwk["x"]  # base64url unpadded (Node createPublicKey requires it)


# --------------------------------------------------------------------------- #
# Sign / self-verify / tamper
# --------------------------------------------------------------------------- #
def test_sign_and_self_verify_roundtrip(aar_env):
    from warlock import aar

    tid = aar.emit_for_audit(kind="scope.violation", command="nmap 8.8.8.8",
                             target="8.8.8.8", note="out-of-scope", outcome="refused")
    from warlock.aar import store

    rec = store.get_record(tid)
    pub = aar.get_keystore().public_jwk()
    assert aar.verify(rec, pub) is True
    # Tamper a SIGNED field → verification fails.
    rec["reason"] = "TAMPERED"
    assert aar.verify(rec, pub) is False


def test_sig_shape(aar_env):
    from warlock import aar
    from warlock.aar import store

    tid = aar.emit_for_audit(kind="job.submit", command="nmap 10.0.0.5",
                             target="10.0.0.5", note="quick", outcome="submitted")
    rec = store.get_record(tid)
    assert rec["sig"]["alg"] == "Ed25519"
    assert rec["sig"]["by"] == rec["subject"]          # team-lead recipe: sig.by = subject
    assert "=" not in rec["sig"]["value"]               # base64url unpadded


# --------------------------------------------------------------------------- #
# Record shape (L1) + evidence custody
# --------------------------------------------------------------------------- #
def test_emit_builds_l1_shaped_record(aar_env):
    _engage()
    from warlock import aar
    from warlock.aar import store

    tid = aar.emit_for_audit(kind="scope.violation", command="aireplay-ng --deauth",
                             target="11:22:33:44:55:66", note="out-of-scope", outcome="refused")
    rec = store.get_record(tid)
    for k in ("aar", "subject", "principal", "task", "verdict", "reason", "issued", "sig"):
        assert k in rec, f"missing L0 field {k}"
    assert rec["aar"] == "0.02"
    assert rec["ground_truth"] == "confirmed"
    chk = rec["checks"][0]
    for k in ("source", "query", "observed_at", "response_sha256"):
        assert chk[k], f"check missing {k}"
    assert rec["verifier"]["id"] == rec["subject"]      # same-principal self-attestation
    assert rec["verifier"]["independence"] == "same_principal"


def test_response_sha256_recomputes_from_disk(aar_env):
    """Custody: read the stored preimage FILE, canonicalize THAT, and confirm the
    hash equals the record's commitment (the spec's normative custody rule)."""
    _engage()
    from warlock import aar
    from warlock.aar import preimage, store

    tid = aar.emit_for_audit(kind="job.submit", command="hashcat -m 22000 cap.hc22000",
                             target="aa:bb:cc:dd:ee:ff", note="crack", outcome="submitted")
    rec = store.get_record(tid)
    on_disk = preimage.load_preimage(tid)            # the FULL custody artifact
    assert on_disk is not None
    assert preimage.response_sha256(on_disk) == rec["checks"][0]["response_sha256"]
    # The real engagement scope (not a placeholder) is committed in the preimage.
    assert on_disk["response"]["scope"]["bssids"] == ["aa:bb:cc:dd:ee:ff"]


def test_disabled_emits_nothing(aar_env, monkeypatch):
    monkeypatch.setenv("WARLOCK_AAR", "0")
    from warlock.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    from warlock import aar

    assert aar.emit_for_audit(kind="job.submit", command="x", target="y", note="", outcome="submitted") is None


# --------------------------------------------------------------------------- #
# prior-chain (L3 forward-compat)
# --------------------------------------------------------------------------- #
def test_prior_chain_links_records(aar_env):
    import hashlib

    from warlock import aar
    from warlock.aar import store
    from warlock.aar.keystore import b64u
    from warlock.aar.signer import canonicalize_record

    t1 = aar.emit_for_audit(kind="job.submit", command="cmd1", target="t1", note="", outcome="submitted")
    t2 = aar.emit_for_audit(kind="job.submit", command="cmd2", target="t2", note="", outcome="submitted")
    r1, r2 = store.get_record(t1), store.get_record(t2)
    assert "prior" not in r1                          # first record has no prior
    expect = b64u(hashlib.sha256(canonicalize_record(r1)).digest())
    assert r2["prior"] == expect                       # chained to the previous record


# --------------------------------------------------------------------------- #
# did.json
# --------------------------------------------------------------------------- #
def test_did_document_shape(aar_env):
    from warlock import aar
    from warlock.config import get_settings

    doc = aar.deck_did_document()
    assert doc["id"] == get_settings().aar_subject_did
    vm = doc["verificationMethod"][0]
    assert vm["publicKeyJwk"]["kty"] == "OKP"
    assert vm["controller"] == doc["id"]


# --------------------------------------------------------------------------- #
# No symmetric MACs anywhere in the package
# --------------------------------------------------------------------------- #
def test_no_hmac_in_aar_package():
    for p in AAR_PKG.glob("*.py"):
        assert "HMAC" not in p.read_text(encoding="utf-8"), f"{p.name} mentions HMAC"


# --------------------------------------------------------------------------- #
# Wiring: a gated refusal through the runner writes a signed record
# --------------------------------------------------------------------------- #
def test_runner_scope_violation_emits_record(aar_env):
    import asyncio

    from warlock.aar import store
    from warlock.db import init_db
    from warlock.jobs import runner

    init_db()  # ensure the audit_log table exists on the bound engine
    before = len(store.list_records())
    # engagement OFF (autouse) → runner.submit refuses + writes scope.violation +
    # (via the wired hook) a signed AAR record.
    with pytest.raises(PermissionError):
        asyncio.run(runner.submit("wifi.deauth", ["aireplay-ng"], requires_engagement=True,
                                  target="11:22:33:44:55:66", note="deauth"))
    recs = store.list_records()
    assert len(recs) == before + 1
    assert recs[0]["kind"] == "scope.violation"


# --------------------------------------------------------------------------- #
# Canonicalization byte-equality with the reference oracle (interop guard)
# --------------------------------------------------------------------------- #
def test_canonicalize_matches_oracle(aar_env):
    oracle = _find_oracle()
    if oracle is None:
        pytest.skip("node/oracle not available — cross-verify gate runs where vendor/acp is present")
    from warlock import aar
    from warlock.aar import store
    from warlock.aar.signer import canonicalize_record

    tid = aar.emit_for_audit(kind="scope.violation", command="nmap -sV 8.8.8.8",
                             target="8.8.8.8", note="out-of-scope: portscan", outcome="refused")
    rec = store.get_record(tid)
    py_canon = canonicalize_record(rec)
    # Run the oracle's own canonical() over the same record.
    js = (
        'const fs=require("fs");'
        'function canonical(o){const s=(v)=>{if(Array.isArray(v))return v.map(s);'
        'if(v&&typeof v==="object"){const x={};for(const k of Object.keys(v).sort()){'
        'if(k==="sig"||k.startsWith("_"))continue;x[k]=s(v[k]);}return x;}return v;};'
        'return JSON.stringify(s(o));}'
        'process.stdout.write(canonical(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))));'
    )
    recf = aar_env / "rec_canon.json"
    recf.write_text(json.dumps(rec))
    out = subprocess.run(["node", "-e", js, str(recf)], capture_output=True)
    assert out.returncode == 0, out.stderr.decode()
    assert py_canon == out.stdout, "rfc8785 canonicalization diverges from the oracle"


# --------------------------------------------------------------------------- #
# THE conformance gate: oracle verify must reach L1 (and FAIL when tampered).
# --------------------------------------------------------------------------- #
def test_oracle_conformance_l1_and_tamper_fails(aar_env):
    oracle = _find_oracle()
    if oracle is None:
        pytest.skip("node/oracle not available — cross-verify gate runs where vendor/acp is present")
    _engage()
    from warlock import aar
    from warlock.aar import preimage, store

    tid = aar.emit_for_audit(kind="scope.violation", command="nmap -sV 8.8.8.8",
                             target="8.8.8.8", note="out-of-scope: portscan vuln", outcome="refused")
    rec = store.get_record(tid)
    recf = aar_env / "record.json"
    didf = aar_env / "did.json"
    recf.write_text(json.dumps(rec))
    didf.write_text(json.dumps(aar.deck_did_document()))

    # Custody: hash recomputes from the stored preimage.
    on_disk = preimage.load_preimage(tid)
    assert preimage.response_sha256(on_disk) == rec["checks"][0]["response_sha256"]

    res = subprocess.run(["node", oracle, "verify", str(recf), "--did-json", str(didf)],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    # Assert the LITERAL level (L0 also exits 0 — exit code alone is not enough).
    assert "conformance: L1" in res.stdout, res.stdout
    assert "Ed25519 signature valid" in res.stdout

    # Tamper a SIGNED field → signature must fail → conformance FAIL (exit 2).
    rec["reason"] = "TAMPERED — never happened"
    recf.write_text(json.dumps(rec))
    bad = subprocess.run(["node", oracle, "verify", str(recf), "--did-json", str(didf)],
                         capture_output=True, text=True)
    assert bad.returncode == 2, bad.stdout
    assert "conformance: FAIL" in bad.stdout
