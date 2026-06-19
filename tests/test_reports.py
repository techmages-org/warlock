"""Tests for the Reports v2 module — templates, wardrive aggregation,
time-window scoping, timeline/loot/gps aggregation, and preflight structure."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA", "/tmp/warlock-test-reports")

import json
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# --- A realistic airodump CSV fixture (CRLF, trailing spaces, blank-line split).
_AIRODUMP_CSV = (
    "\r\n"
    "BSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, "
    "Authentication, Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key\r\n"
    "20:23:51:91:66:40, 2026-06-19 09:49:00, 2026-06-19 09:50:00,  1, 360, "
    "WPA3 WPA2, CCMP, SAE PSK, -41,       36,       58,   0.  0.  0.  0,   8, "
    "jb-wifi7, \r\n"
    "20:23:51:91:65:40, 2026-06-19 09:49:05, 2026-06-19 09:50:00, 11, 360, "
    "WPA3 WPA2, CCMP, SAE PSK, -63,       21,       37,   0.  0.  0.  0,   8, "
    "jb-wifi7, \r\n"
    "FA:8F:CA:8F:DC:FD, 2026-06-19 09:49:10, 2026-06-19 09:50:00,  6, 130, "
    "OPN, ,   , -38,       52,        0,   0.  0.  0.  0,  25, guest-open, \r\n"
    "7E:4D:8F:C5:0A:FF, 2026-06-19 09:49:15, 2026-06-19 09:50:00,  6,  65, "
    "WPA2, CCMP, PSK, -49,       40,        0,   0.  0.  0.  0,  10, DIRECT-FF, \r\n"
    # This AP is OUTSIDE the 09:49–09:50 window (later in the day).
    "AA:BB:CC:DD:EE:FF, 2026-06-19 18:00:00, 2026-06-19 18:01:00,  1, 360, "
    "WPA2, CCMP, PSK, -55,       10,        0,   0.  0.  0.  0,   4, late-ap, \r\n"
    "\r\n"
    "Station MAC, First time seen, Last time seen, Power, # packets, BSSID, "
    "Probed ESSIDs\r\n"
    "78:42:1C:2F:25:38, 2026-06-19 09:49:00, 2026-06-19 09:50:00, -67,        9, "
    "(not associated) ,Starlink-direct\r\n"
    "3C:31:74:EB:34:50, 2026-06-19 09:49:01, 2026-06-19 09:50:00, -60,        6, "
    "20:23:51:91:66:40,\r\n"
    # Client outside the window.
    "00:11:22:33:44:55, 2026-06-19 18:00:00, 2026-06-19 18:01:00, -60,      999, "
    "(not associated) ,late-client\r\n"
    "\r\n"
)

_GPX = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<gpx version="1.1" creator="Warlock" xmlns="http://www.topografix.com/GPX/1/1">\n'
    "<trk><name>test.gpx</name><trkseg>\n"
    '<trkpt lat="30.434501167" lon="-97.6834715"><ele>257.0</ele>'
    "<time>2026-06-19T09:49:00.000Z</time></trkpt>\n"
    '<trkpt lat="30.434601167" lon="-97.6835715"><ele>256.7</ele>'
    "<time>2026-06-19T09:49:30.000Z</time></trkpt>\n"
    '<trkpt lat="30.434701167" lon="-97.6836715"><ele>256.4</ele>'
    "<time>2026-06-19T09:50:00.000Z</time></trkpt>\n"
    # outside window
    '<trkpt lat="30.435000000" lon="-97.6840000"><ele>255.0</ele>'
    "<time>2026-06-19T18:00:00.000Z</time></trkpt>\n"
    "</trkseg></trk>\n"
    "</gpx>\n"
)


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """Build a TestClient rooted at a tmp data dir seeded with sample captures."""
    # Seed artifact directories.
    (tmp_path / "captures" / "wifi").mkdir(parents=True)
    (tmp_path / "tracks").mkdir(parents=True)
    (tmp_path / "reports").mkdir(parents=True)
    (tmp_path / "aar" / "records").mkdir(parents=True)

    (tmp_path / "captures" / "wifi" / "airodump-20260619-01.csv").write_text(_AIRODUMP_CSV)
    (tmp_path / "captures" / "wifi" / "airodump-20260619-01.cap").write_bytes(b"\x00" * 100)
    (tmp_path / "tracks" / "20260619-094900.gpx").write_text(_GPX)

    # AAR record inside the window + one outside.
    (tmp_path / "aar" / "records" / "engagement.ended-20260619T094900Z-abc.json").write_text(json.dumps({
        "issued": "2026-06-19T09:49:30Z",
        "_kind": "engagement.ended",
        "task": {"claim": "ended the engagement"},
        "verdict": "verified",
        "reason": "done",
    }))
    (tmp_path / "aar" / "records" / "engagement.started-20260619T180000Z-def.json").write_text(json.dumps({
        "issued": "2026-06-19T18:00:00Z",
        "_kind": "engagement.started",
        "task": {"claim": "started late"},
        "verdict": "verified",
    }))

    monkeypatch.setenv("WARLOCK_DATA", str(tmp_path))
    from warlock.config import get_settings
    get_settings.cache_clear()

    from warlock.server import create_app
    return TestClient(create_app())


@pytest.fixture()
def data_root(client):
    """Return the tmp data root the client is wired to."""
    from warlock.config import get_settings
    return get_settings().data


# --------------------------------------------------------------------------- #
# /api/reports/templates
# --------------------------------------------------------------------------- #
def test_templates_list_has_expected_ids(client):
    r = client.get("/api/reports/templates")
    assert r.status_code == 200
    ids = [t["id"] for t in r.json()["templates"]]
    assert ids == ["wardrive_summary", "engagement_timeline", "loot_inventory", "gps_movement"]


def test_templates_have_label_icon_description(client):
    for t in client.get("/api/reports/templates").json()["templates"]:
        assert t["label"]
        assert t["icon"]
        assert t["description"]


# --------------------------------------------------------------------------- #
# Wardrive aggregation (module-level function)
# --------------------------------------------------------------------------- #
def test_aggregate_wardrive_counts_aps_in_window(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    # 4 APs inside window (jb-wifi7 x2, guest-open, DIRECT-FF); late-ap excluded.
    assert data["total_aps"] == 4
    assert data["unique_bssids"] == 4
    assert data["total_clients"] == 2  # late-client excluded


def test_aggregate_wardrive_window_in_output(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["window"]["start"] == "2026-06-19 09:49:00"
    assert data["window"]["end"] == "2026-06-19 09:50:00"


def test_aggregate_wardrive_encryption_breakdown(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    enc = data["encryption_breakdown"]
    # Standard buckets always present.
    for k in ("WPA3", "WPA2", "WPA3 WPA2", "Open", "WEP"):
        assert k in enc
    assert enc["WPA3 WPA2"] == 2  # jb-wifi7 x2
    assert enc["Open"] == 1        # guest-open (OPN)
    assert enc["WPA2"] == 1        # DIRECT-FF
    assert enc["WEP"] == 0


def test_aggregate_wardrive_channel_distribution(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    chan = data["channel_distribution"]
    assert chan == {"1": 1, "6": 2, "11": 1}


def test_aggregate_wardrive_signal_distribution(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    sig = data["signal_distribution"]
    # 4 APs with powers -41,-63,-38,-49. Bins by floor(v/10)*10, strongest-first.
    #   -38 → floor -40 → "-30 to -40";  -41 → floor -50 → "-40 to -50";
    #   -49 → floor -50 → "-40 to -50";  -63 → floor -70 → "-60 to -70".
    ranges = [s["range"] for s in sig]
    assert ranges == ["-30 to -40", "-40 to -50", "-60 to -70"]  # floor desc
    counts = sum(s["count"] for s in sig)
    assert counts == 4
    by_range = {s["range"]: s["count"] for s in sig}
    assert by_range["-30 to -40"] == 1   # -38
    assert by_range["-40 to -50"] == 2   # -41, -49
    assert by_range["-60 to -70"] == 1   # -63


def test_aggregate_wardrive_top_ssids(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    top = data["top_ssids"]
    by_ssid = {e["ssid"]: e["count"] for e in top}
    # jb-wifi7 has two distinct BSSIDs.
    assert by_ssid["jb-wifi7"] == 2
    assert by_ssid["guest-open"] == 1
    assert top[0]["ssid"] == "jb-wifi7"  # sorted by count desc


def test_aggregate_wardrive_top_clients(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    top = data["top_clients"]
    by_mac = {e["mac"]: e["packets"] for e in top}
    assert by_mac["78:42:1C:2F:25:38"] == 9
    assert by_mac["3C:31:74:EB:34:50"] == 6
    assert top[0]["packets"] >= top[-1]["packets"]


def test_aggregate_wardrive_aps_over_time_bucketed(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    series = data["aps_over_time"]
    # All four in-window APs fall in the 09:45 bucket (floor to 5 min).
    assert series[0]["ts"] == "09:45"
    assert series[0]["count"] == 4


# --------------------------------------------------------------------------- #
# Time-window scoping — data outside the window is excluded
# --------------------------------------------------------------------------- #
def test_wide_window_includes_late_ap(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 00:00:00", "2026-06-19 23:59:59")
    assert data["total_aps"] == 5   # all
    assert data["total_clients"] == 3


def test_narrow_window_excludes_everything_early(client):
    from warlock.modules.reports import aggregate_wardrive_data
    data = aggregate_wardrive_data("2026-06-19 06:00:00", "2026-06-19 06:05:00")
    assert data["total_aps"] == 0
    assert data["total_clients"] == 0
    assert data["encryption_breakdown"]["WPA2"] == 0


def test_generate_endpoint_wardrive(client):
    r = client.post("/api/reports/generate/wardrive_summary", json={
        "window_start": "2026-06-19 09:49:00",
        "window_end": "2026-06-19 09:50:00",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["template"] == "wardrive_summary"
    assert body["report_id"].startswith("rpt-")
    assert body["data"]["total_aps"] == 4
    assert body["generated_at"]


def test_generate_endpoint_unknown_template_404(client):
    r = client.post("/api/reports/generate/nope", json={})
    assert r.status_code == 404


def test_generate_persists_report_file(client, data_root):
    r = client.post("/api/reports/generate/wardrive_summary", json={
        "window_start": "2026-06-19 09:49:00",
        "window_end": "2026-06-19 09:50:00",
    })
    rid = r.json()["report_id"]
    saved = data_root / "reports" / f"{rid}.json"
    assert saved.exists()
    doc = json.loads(saved.read_text())
    assert doc["template"] == "wardrive_summary"


# --------------------------------------------------------------------------- #
# Timeline / loot / gps aggregation
# --------------------------------------------------------------------------- #
def test_engagement_timeline_filters_window(client):
    from warlock.modules.reports import aggregate_engagement_timeline
    data = aggregate_engagement_timeline("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["event_count"] == 1
    assert data["events"][0]["kind"] == "engagement.ended"
    assert data["events"][0]["claim"] == "ended the engagement"


def test_engagement_timeline_wide(client):
    from warlock.modules.reports import aggregate_engagement_timeline
    data = aggregate_engagement_timeline("2026-06-19 00:00:00", "2026-06-19 23:59:59")
    assert data["event_count"] == 2
    # sorted ascending by timestamp
    assert data["events"][0]["ts"] <= data["events"][1]["ts"]


def test_loot_inventory_filters_by_mtime(client, monkeypatch, data_root):
    import calendar
    from warlock.modules.reports import aggregate_loot_inventory
    # Pin all artifact mtimes to 09:49:30 UTC. Use calendar.timegm so the epoch
    # is interpreted as UTC (the module reads mtime back via utcfromtimestamp);
    # a naive datetime.timestamp() would be off by the local TZ offset.
    target_ts = calendar.timegm(datetime(2026, 6, 19, 9, 49, 30).timetuple())
    for p in (data_root / "captures" / "wifi").iterdir():
        os.utime(p, (target_ts, target_ts))
    os.utime(data_root / "tracks" / "20260619-094900.gpx", (target_ts, target_ts))

    data = aggregate_loot_inventory("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["total_files"] >= 2  # .cap + .csv + .gpx at least
    types = data["by_type"]
    assert types.get("wifi_csv", 0) == 1
    assert types.get("wifi_pcap", 0) == 1
    assert types.get("gps_track", 0) == 1


def test_loot_inventory_excludes_out_of_window(client, monkeypatch, data_root):
    from warlock.modules.reports import aggregate_loot_inventory
    # Set mtimes far outside the window.
    out_ts = datetime(2025, 1, 1, 0, 0, 0).timestamp()
    for p in (data_root / "captures" / "wifi").iterdir():
        os.utime(p, (out_ts, out_ts))
    os.utime(data_root / "tracks" / "20260619-094900.gpx", (out_ts, out_ts))
    data = aggregate_loot_inventory("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["total_files"] == 0


def test_gps_movement_filters_window(client):
    from warlock.modules.reports import aggregate_gps_movement
    data = aggregate_gps_movement("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["trackpoint_count"] == 3  # 4 total, 1 outside window
    assert len(data["coordinates"]) == 3
    assert data["distance_m"] > 0
    assert data["bounds"]["min_lat"] <= data["bounds"]["max_lat"]
    # speed profile has one fewer entry than points.
    assert len(data["speed_profile"]) == 2


def test_gps_movement_empty_window(client):
    from warlock.modules.reports import aggregate_gps_movement
    data = aggregate_gps_movement("2025-01-01 00:00:00", "2025-01-01 00:01:00")
    assert data["trackpoint_count"] == 0
    assert data["coordinates"] == []
    assert data["distance_m"] == 0


# --------------------------------------------------------------------------- #
# Robustness: empty / malformed CSVs
# --------------------------------------------------------------------------- #
def test_empty_csv_directory_returns_zeros(client, data_root):
    from warlock.modules.reports import aggregate_wardrive_data
    # Remove the seeded CSV.
    (data_root / "captures" / "wifi" / "airodump-20260619-01.csv").unlink()
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["total_aps"] == 0
    assert data["encryption_breakdown"]["WPA2"] == 0


def test_malformed_csv_is_skipped(client, data_root):
    from warlock.modules.reports import aggregate_wardrive_data
    # Overwrite with garbage that has no valid rows.
    (data_root / "captures" / "wifi" / "airodump-garbage.csv").write_text(
        "this is not, a valid, csv\r\nrandom, line\r\n"
    )
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    # The good CSV still contributes its 4 APs; garbage contributes 0.
    assert data["total_aps"] == 4


def test_header_only_csv_parses_to_empty(client, data_root):
    from warlock.modules.reports import aggregate_wardrive_data
    (data_root / "captures" / "wifi" / "airodump-empty.csv").write_text(
        "\r\nBSSID, First time seen, Last time seen, channel, Speed, Privacy, "
        "Cipher, Authentication, Power, # beacons, # IV, LAN IP, ID-length, "
        "ESSID, Key\r\n\r\nStation MAC, First time seen, Last time seen, Power, "
        "# packets, BSSID, Probed ESSIDs\r\n\r\n"
    )
    data = aggregate_wardrive_data("2026-06-19 09:49:00", "2026-06-19 09:50:00")
    assert data["total_aps"] == 4  # only the seeded good CSV


# --------------------------------------------------------------------------- #
# /api/reports/list
# --------------------------------------------------------------------------- #
def test_list_reports_after_generate(client):
    client.post("/api/reports/generate/wardrive_summary", json={
        "window_start": "2026-06-19 09:49:00",
        "window_end": "2026-06-19 09:50:00",
    })
    r = client.get("/api/reports/list")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 1
    entry = body["reports"][0]
    assert "id" in entry and "mtime" in entry and "template" in entry


# --------------------------------------------------------------------------- #
# /api/reports/preflight
# --------------------------------------------------------------------------- #
def test_preflight_structure(client):
    r = client.post("/api/reports/preflight")
    assert r.status_code == 200
    body = r.json()
    for key in ("ai_enabled", "internet", "api_accessible", "all_pass", "details"):
        assert key in body, f"missing {key}"
    assert isinstance(body["ai_enabled"], bool)
    assert isinstance(body["internet"], bool)
    assert isinstance(body["api_accessible"], bool)
    assert isinstance(body["all_pass"], bool)
    assert body["all_pass"] == (body["ai_enabled"] and body["internet"] and body["api_accessible"])
    assert "provider_key" in body["details"]


def test_preflight_no_key_means_ai_disabled(client, monkeypatch):
    # Strip all known AI keys.
    for key in (
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
        "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "WARLOCK_AI_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    r = client.post("/api/reports/preflight")
    body = r.json()
    assert body["ai_enabled"] is False
    assert body["api_accessible"] is False
    assert body["all_pass"] is False
    assert body["details"]["provider_key"] is None
