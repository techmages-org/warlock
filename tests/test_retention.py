"""Tests for capture retention module."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from warlock.config import get_settings
from warlock.modules.retention import (
    RetentionConfig,
    RetentionModule,
    _captures_breakdown,
    _disk_usage,
    _scan_purgeable,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def capture_tree(tmp_path: Path):
    """Build a fake captures dir with logs, caps, csvs."""
    cap = tmp_path / "captures" / "wifi"
    cap.mkdir(parents=True)

    # Oversized .log (2MB — exceeds 1MB threshold)
    log_file = cap / "airodump-20260601-120000.log"
    log_file.write_bytes(b"x" * (2 * 1024 * 1024))
    # Make it look old
    old_ts = time.time() - (45 * 86400)  # 45 days old
    os.utime(log_file, (old_ts, old_ts))

    # Small .log (under threshold — should be kept)
    small_log = cap / "airodump-20260619-120000.log"
    small_log.write_bytes(b"x" * 100)  # 100 bytes

    # Old .cap (over 30d — purgeable)
    old_cap = cap / "airodump-20260601-120000-01.cap"
    old_cap.write_bytes(b"cap" * 1000)
    os.utime(old_cap, (old_ts, old_ts))

    # Recent .cap (under 30d — kept)
    new_cap = cap / "airodump-20260619-120000-01.cap"
    new_cap.write_bytes(b"cap" * 1000)

    # CSV (always kept)
    csv_file = cap / "airodump-20260601-120000-01.csv"
    csv_file.write_text("BSSID,First time seen,Last time seen,channel,Speed,Privacy,Power\n")

    # GeoJSON (always kept)
    geo_file = cap / "airodump-20260601-120000-geo.json"
    geo_file.write_text('{"type":"FeatureCollection","features":[]}')

    os.environ["WARLOCK_DATA"] = str(tmp_path)
    get_settings.cache_clear()

    return tmp_path


class TestScanPurgeable:
    def test_finds_oversized_logs(self, capture_tree):
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=True)
        result = _scan_purgeable(cfg)
        paths = [r["path"] for r in result]
        assert any("20260601" in p and p.endswith(".log") for p in paths)

    def test_keeps_small_logs(self, capture_tree):
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=True)
        result = _scan_purgeable(cfg)
        paths = [r["path"] for r in result]
        assert not any("20260619" in p and p.endswith(".log") for p in paths)

    def test_finds_old_caps(self, capture_tree):
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=True)
        result = _scan_purgeable(cfg)
        paths = [r["path"] for r in result]
        assert any("20260601" in p and p.endswith(".cap") for p in paths)

    def test_keeps_recent_caps(self, capture_tree):
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=True)
        result = _scan_purgeable(cfg)
        paths = [r["path"] for r in result]
        assert not any("20260619" in p and p.endswith(".cap") for p in paths)

    def test_never_lists_csv_or_json(self, capture_tree):
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=True)
        result = _scan_purgeable(cfg)
        exts = {r["ext"] for r in result}
        assert ".csv" not in exts
        assert ".json" not in exts

    def test_empty_dir(self, tmp_path):
        os.environ["WARLOCK_DATA"] = str(tmp_path)
        get_settings.cache_clear()
        cfg = RetentionConfig()
        assert _scan_purgeable(cfg) == []


class TestBreakdown:
    def test_counts_by_extension(self, capture_tree):
        bd = _captures_breakdown()
        assert ".log" in bd
        assert ".cap" in bd
        assert ".csv" in bd
        assert bd[".log"]["count"] == 2
        assert bd[".cap"]["count"] == 2

    def test_sizes_correct(self, capture_tree):
        bd = _captures_breakdown()
        assert bd[".csv"]["size_bytes"] > 0
        assert bd[".log"]["size_bytes"] > bd[".csv"]["size_bytes"]


class TestDiskUsage:
    def test_returns_valid_fields(self, capture_tree):
        du = _disk_usage()
        assert "total_bytes" in du
        assert "used_bytes" in du
        assert "free_bytes" in du
        assert "pct" in du
        assert du["total_bytes"] > 0


class TestRetentionPolicy:
    def test_dry_run_does_not_delete(self, capture_tree):
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=True)
        purgeable = _scan_purgeable(cfg)
        # Verify files still exist (paths are relative to captures/)
        base = capture_tree / "captures"
        for item in purgeable:
            assert (base / item["path"]).exists()

    def test_purge_deletes_files(self, capture_tree):
        """Verify purge actually removes files when not in dry-run."""
        base = capture_tree / "captures"
        old_log = base / "wifi" / "airodump-20260601-120000.log"
        old_cap = base / "wifi" / "airodump-20260601-120000-01.cap"

        assert old_log.exists()
        assert old_cap.exists()

        # Manually purge (simulating what the API does)
        cfg = RetentionConfig(log_max_mb=1, cap_max_age_days=30, dry_run=False)
        for item in _scan_purgeable(cfg):
            (base / item["path"]).unlink()

        assert not old_log.exists()
        assert not old_cap.exists()
        # These should still be there
        assert (base / "wifi" / "airodump-20260619-120000.log").exists()
        assert (base / "wifi" / "airodump-20260619-120000-01.cap").exists()
        assert (base / "wifi" / "airodump-20260601-120000-01.csv").exists()


class TestRetentionModule:
    def test_status_endpoint(self, capture_tree):
        mod = RetentionModule()
        r = mod.router
        # Find the status route handler
        for route in r.routes:
            if hasattr(route, "path") and route.path == "/api/retention/status":
                result = route.endpoint()
                assert "disk" in result
                assert "breakdown" in result
                assert "purgeable" in result
                assert "config" in result
                break

    def test_dry_run_purge(self, capture_tree):
        mod = RetentionModule()
        r = mod.router
        for route in r.routes:
            if hasattr(route, "path") and route.path == "/api/retention/purge":
                result = route.endpoint(confirm=False)
                assert result["action"] == "dry_run"
                assert result["would_delete"] > 0
                break

    def test_config_update(self, capture_tree):
        mod = RetentionModule()
        r = mod.router
        for route in r.routes:
            if hasattr(route, "path") and route.path == "/api/retention/config" and hasattr(route, "endpoint"):
                # PUT route
                if route.methods and "PUT" in route.methods:
                    result = route.endpoint(log_max_mb=50, cap_max_age_days=7)
                    assert result["log_max_mb"] == 50
                    assert result["cap_max_age_days"] == 7
                    break

    def test_tab_id(self):
        mod = RetentionModule()
        assert mod.tab_id == "retention"
