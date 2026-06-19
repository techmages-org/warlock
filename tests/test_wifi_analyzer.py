"""Tests for the WiFi Analyzer module — frequency/channel mapping,
signal quality classification, scan output parsing, and zone logic."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest


# --------------------------------------------------------------------------- #
# _chan_from_freq — 802.11 frequency-to-channel mapping
# --------------------------------------------------------------------------- #
def test_chan_from_freq_2_4ghz():
    from warlock.modules.wifi_analyzer import _chan_from_freq
    assert _chan_from_freq(2412) == 1
    assert _chan_from_freq(2437) == 6
    assert _chan_from_freq(2472) == 13
    assert _chan_from_freq(2484) == 14  # Japan-only


def test_chan_from_freq_5ghz():
    from warlock.modules.wifi_analyzer import _chan_from_freq
    assert _chan_from_freq(5180) == 36
    assert _chan_from_freq(5240) == 48
    assert _chan_from_freq(5745) == 149


def test_chan_from_freq_6ghz():
    from warlock.modules.wifi_analyzer import _chan_from_freq
    assert _chan_from_freq(5955) == 1
    assert _chan_from_freq(6115) == 33


def test_chan_from_freq_edge_cases():
    from warlock.modules.wifi_analyzer import _chan_from_freq
    assert _chan_from_freq(None) is None
    assert _chan_from_freq(0) is None
    assert _chan_from_freq(9999) is None  # unknown freq


# --------------------------------------------------------------------------- #
# _band — frequency band classification
# --------------------------------------------------------------------------- #
def test_band_classification():
    from warlock.modules.wifi_analyzer import _band
    assert _band(2412) == "2.4"
    assert _band(2484) == "2.4"
    assert _band(5180) == "5"
    assert _band(5900) == "5"
    assert _band(5955) == "6"
    assert _band(7115) == "6"
    assert _band(None) is None


# --------------------------------------------------------------------------- #
# _quality — signal strength quality label
# --------------------------------------------------------------------------- #
def test_quality_thresholds():
    from warlock.modules.wifi_analyzer import _quality
    assert _quality(-40) == "excellent"
    assert _quality(-60) == "excellent"
    assert _quality(-61) == "good"
    assert _quality(-70) == "good"
    assert _quality(-71) == "fair"
    assert _quality(-80) == "fair"
    assert _quality(-81) == "poor"
    assert _quality(-95) == "poor"
    assert _quality(None) == "unknown"


# --------------------------------------------------------------------------- #
# _zone — walk-test coverage classification
# --------------------------------------------------------------------------- #
def test_zone_classification():
    from warlock.modules.wifi_analyzer import _zone
    assert _zone(-50) == "hot"
    assert _zone(-60) == "hot"
    assert _zone(-61) == "warm"
    assert _zone(-70) == "warm"
    assert _zone(-71) == "cold"
    assert _zone(-80) == "cold"
    assert _zone(-81) == "dead"
    assert _zone(None) == "dead"


# --------------------------------------------------------------------------- #
# _parse_scan — iw dev scan output parsing
# --------------------------------------------------------------------------- #
def test_parse_scan_basic():
    from warlock.modules.wifi_analyzer import _parse_scan
    text = """BSS aa:bb:cc:dd:ee:ff(on wlan0)
\tfreq: 2412
\tsignal: -65.00 dBm
\tSSID: TestNetwork
BSS 11:22:33:44:55:66(on wlan0)
\tfreq: 5180
\tsignal: -45.00 dBm
\tSSID: 5GHzNet"""
    aps = _parse_scan(text)
    assert len(aps) == 2
    assert aps[0]["bssid"] == "aa:bb:cc:dd:ee:ff"
    assert aps[0]["ssid"] == "TestNetwork"
    assert aps[0]["channel"] == 1
    assert aps[0]["band"] == "2.4"
    assert aps[0]["quality"] == "good"
    assert aps[1]["bssid"] == "11:22:33:44:55:66"
    assert aps[1]["channel"] == 36
    assert aps[1]["quality"] == "excellent"


def test_parse_scan_hidden_ssid():
    from warlock.modules.wifi_analyzer import _parse_scan
    text = """BSS aa:bb:cc:dd:ee:ff(on wlan0)
\tfreq: 2412
\tsignal: -70.00 dBm
\tSSID: """
    aps = _parse_scan(text)
    assert len(aps) == 1
    assert aps[0]["ssid"] == "(hidden)"


def test_parse_scan_empty():
    from warlock.modules.wifi_analyzer import _parse_scan
    assert _parse_scan("") == []
    assert _parse_scan("garbage\nno bss here") == []


# --------------------------------------------------------------------------- #
# _est_distance_ft — coarse RSSI distance estimate
# --------------------------------------------------------------------------- #
def test_est_distance_ft_returns_positive():
    from warlock.modules.wifi_analyzer import _est_distance_ft
    assert _est_distance_ft(-40) == 3  # ~1m = ~3ft
    d70 = _est_distance_ft(-70)
    assert d70 is not None and d70 > 0
    assert _est_distance_ft(None) is None
    # Stronger signal = closer
    d50 = _est_distance_ft(-50)
    d80 = _est_distance_ft(-80)
    assert d50 is not None and d80 is not None and d50 < d80
