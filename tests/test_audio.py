"""Tests for the Audio module — wpctl status parsing."""
import os

os.environ["WARLOCK_WEB_PASSWORD"] = ""
os.environ.setdefault("WARLOCK_DATA_DIR", "/tmp/warlock-test")

import pytest


# --------------------------------------------------------------------------- #
# _parse_status — wpctl output parser
# --------------------------------------------------------------------------- #
def test_parse_status_sinks_and_sources():
    from warlock.modules.audio import _parse_status
    text = """Audio
Sinks:
 * 54. RP1-Audio-Out [vol: 1.50]
    55. Yealink BT51 [vol: 1.00]
Sources:
 * 84. Samson Go Mic Video [vol: 1.00]
    85. Monitor of RP1-Audio-Out [vol: 1.00]
"""
    result = _parse_status(text)
    assert len(result["sinks"]) == 2
    assert len(result["sources"]) == 2
    # Default sink
    assert result["sinks"][0]["id"] == 54
    assert result["sinks"][0]["default"] is True
    assert result["sinks"][0]["volume"] == 1.50
    assert result["sinks"][0]["name"] == "RP1-Audio-Out"
    # Non-default
    assert result["sinks"][1]["default"] is False
    # Source
    assert result["sources"][0]["id"] == 84
    assert result["sources"][0]["default"] is True


def test_parse_status_muted_device():
    from warlock.modules.audio import _parse_status
    text = """Sinks:
 *   54. Headset [vol: 0.50 [MUTED]]
"""
    result = _parse_status(text)
    assert len(result["sinks"]) == 1
    assert result["sinks"][0]["muted"] is True
    assert result["sinks"][0]["volume"] == 0.50


def test_parse_status_empty():
    from warlock.modules.audio import _parse_status
    result = _parse_status("")
    assert result["sinks"] == []
    assert result["sources"] == []


def test_parse_status_ignores_other_sections():
    from warlock.modules.audio import _parse_status
    text = """Audio
Sinks:
 * 54. Out [vol: 1.00]
Streams:
   1. Firefox [vol: 1.00]
"""
    result = _parse_status(text)
    assert len(result["sinks"]) == 1
    # Streams should not pollute sinks
