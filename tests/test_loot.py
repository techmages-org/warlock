"""Tests for the Loot module — artifact scanning, filtering, download, archive, delete."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA", "/tmp/warlock-test-loot")

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """Create a test client with a tmp data root seeded with sample artifacts."""
    # Create artifact directories
    (tmp_path / "captures" / "wifi" / "exports").mkdir(parents=True)
    (tmp_path / "captures" / "wifi" / "cracked").mkdir(parents=True)
    (tmp_path / "captures" / "sdr").mkdir(parents=True)
    (tmp_path / "tracks").mkdir(parents=True)
    (tmp_path / "reports").mkdir(parents=True)
    (tmp_path / "aar" / "records").mkdir(parents=True)
    (tmp_path / "handshakes").mkdir(parents=True)

    # Seed sample artifacts
    (tmp_path / "captures" / "wifi" / "airodump-20260619-01.cap").write_bytes(b"\x00" * 100)
    (tmp_path / "captures" / "wifi" / "airodump-20260619-01.csv").write_text("BSSID,ESSID\nAA:BB,test")
    (tmp_path / "captures" / "wifi" / "airodump-20260619-01-geo.json").write_text('{"type":"FeatureCollection"}')
    (tmp_path / "captures" / "wifi" / "airodump-20260619-01.log").write_text("HUGE LOG DATA")  # should be excluded
    (tmp_path / "captures" / "wifi" / "exports" / "wifi-recon-20260619.csv").write_text("exported,data")
    (tmp_path / "captures" / "wifi" / "cracked" / "target-22000.txt").write_text("hash:password")
    (tmp_path / "tracks" / "20260619-142631.gpx").write_text("<gpx></gpx>")
    (tmp_path / "reports" / "rpt-1234.html").write_text("<html>report</html>")
    (tmp_path / "aar" / "records" / "engagement.started-12345.json").write_text('{"kind":"test"}')
    (tmp_path / "handshakes" / "target.pcap").write_bytes(b"\x00" * 200)

    monkeypatch.setenv("WARLOCK_DATA", str(tmp_path))
    # Clear lru_cache so get_settings() picks up the new data dir
    from warlock.config import get_settings
    get_settings.cache_clear()
    # Invalidate module-level scan cache
    from warlock.modules import loot as loot_mod
    loot_mod._SCAN_CACHE.clear()

    from warlock.server import create_app
    return TestClient(create_app())


# --------------------------------------------------------------------------- #
# /api/loot — index
# --------------------------------------------------------------------------- #
def test_index_returns_artifacts(client):
    r = client.get("/api/loot")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["count"] > 0
    assert "by_type" in data
    assert "total_size_bytes" in data

    # Each artifact has the right shape
    for a in data["artifacts"]:
        assert "id" in a
        assert "type" in a
        assert "module" in a
        assert "path" in a
        assert "name" in a
        assert "size_bytes" in a
        assert "download_url" in a


def test_index_excludes_log_files(client):
    r = client.get("/api/loot")
    paths = [a["path"] for a in r.json()["artifacts"]]
    assert not any(".log" in p for p in paths), "airodump .log files must be excluded"


def test_index_includes_expected_types(client):
    r = client.get("/api/loot")
    types = set(r.json()["by_type"].keys())
    assert "wifi_pcap" in types
    assert "wifi_csv" in types
    assert "gps_track" in types
    assert "report" in types
    assert "wifi_handshake" in types


def test_index_filter_by_type(client):
    r = client.get("/api/loot?type=gps_track")
    assert r.status_code == 200
    artifacts = r.json()["artifacts"]
    assert len(artifacts) == 1
    assert artifacts[0]["type"] == "gps_track"


def test_index_filter_by_module(client):
    r = client.get("/api/loot?module=gps")
    assert r.status_code == 200
    artifacts = r.json()["artifacts"]
    assert all(a["module"] == "gps" for a in artifacts)


def test_by_type_counts_are_correct(client):
    r = client.get("/api/loot")
    by_type = r.json()["by_type"]
    assert by_type["gps_track"]["count"] == 1


# --------------------------------------------------------------------------- #
# /api/loot/download/{path}
# --------------------------------------------------------------------------- #
def test_download_valid_file(client):
    r = client.get("/api/loot/download/tracks/20260619-142631.gpx")
    assert r.status_code == 200
    assert b"<gpx>" in r.content


def test_download_rejects_traversal(client):
    """Path traversal must not escape the data root."""
    # Use encoded path to avoid httpx URL normalization
    r = client.get("/api/loot/download/..%2f..%2f..%2fetc%2fpasswd")
    assert r.status_code in (400, 404)


def test_download_404_missing(client):
    r = client.get("/api/loot/download/tracks/nonexistent.gpx")
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# /api/loot/archive
# --------------------------------------------------------------------------- #
def test_archive_single_file(client):
    r = client.post("/api/loot/archive", json={"paths": ["tracks/20260619-142631.gpx"]})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"


def test_archive_multiple_files(client):
    r = client.post("/api/loot/archive", json={
        "paths": [
            "tracks/20260619-142631.gpx",
            "reports/rpt-1234.html",
        ]
    })
    assert r.status_code == 200
    import zipfile
    import io as _io
    zf = zipfile.ZipFile(_io.BytesIO(r.content))
    names = zf.namelist()
    assert len(names) == 2


def test_archive_empty_paths_returns_400(client):
    r = client.post("/api/loot/archive", json={"paths": []})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# DELETE /api/loot/{path}
# --------------------------------------------------------------------------- #
def test_delete_artifact(client, tmp_path):
    # Invalidate cache before checking
    from warlock.modules import loot as loot_mod
    loot_mod._SCAN_CACHE.clear()

    r = client.delete("/api/loot/tracks/20260619-142631.gpx")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert not (tmp_path / "tracks" / "20260619-142631.gpx").exists()


def test_delete_missing_returns_404(client):
    r = client.delete("/api/loot/tracks/nonexistent.gpx")
    assert r.status_code == 404
