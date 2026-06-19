"""Tests for the Report module — network-health report generation,
report listing, and download validation."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WARLOCK_DATA_DIR", str(tmp_path))
    from warlock.server import create_app
    return TestClient(create_app())


# --------------------------------------------------------------------------- #
# /api/report/list
# --------------------------------------------------------------------------- #
def test_list_returns_reports(client):
    r = client.get("/api/report/list")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "reports" in data
    assert isinstance(data["reports"], list)
    assert data["count"] == len(data["reports"])


# --------------------------------------------------------------------------- #
# /api/report/download — path traversal protection
# --------------------------------------------------------------------------- #
def test_download_rejects_bad_id(client):
    """Report IDs must match rpt-<digits> — prevents path traversal."""
    r = client.get("/api/report/download/rpt-evil-hack")
    assert r.status_code == 400


def test_download_rejects_malformed_id(client):
    r = client.get("/api/report/download/not-a-report")
    assert r.status_code == 400


def test_download_404_for_valid_format_but_missing(client):
    r = client.get("/api/report/download/rpt-9999999999")
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# Internal helpers
# --------------------------------------------------------------------------- #
def test_worst_verdict_logic():
    from warlock.modules.report import _worst
    assert _worst(["PASS", "PASS"]) == "PASS"
    assert _worst(["PASS", "WARN"]) == "WARN"
    assert _worst(["PASS", "WARN", "FAIL"]) == "FAIL"
    assert _worst([]) == "PASS"
    assert _worst(["INFO", "PASS"]) == "PASS"
    assert _worst(["unknown", "FAIL"]) == "FAIL"


def test_html_generation_escapes_content():
    """HTML report should escape user-controlled content (hostname etc.)."""
    from warlock.modules.report import _html
    rep = {
        "summary": {"overall": "PASS"},
        "deck": {"hostname": "<script>alert(1)</script>", "subject_did": None},
        "generated": "2024-01-01T00:00:00Z",
        "sections": {"link": {"verdict": "PASS"}},
    }
    html = _html(rep)
    assert "<script>" not in html  # should be escaped
    assert "&lt;script&gt;" in html
