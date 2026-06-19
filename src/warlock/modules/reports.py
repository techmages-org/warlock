"""Reports v2 — engagement-scoped graphical report generation.

  GET  /api/reports/templates              — available report templates
  POST /api/reports/generate/{template_id} — aggregate data scoped to a time window
  GET  /api/reports/list                   — previously generated reports
  POST /api/reports/preflight              — AI provider + reachability checks

Unlike the legacy ``report`` module (network-health netdiag + wifi_analyzer),
this module aggregates wardrive captures, GPS tracks, AAR records and loot
artifacts scoped to an engagement time window, returning structured data the
frontend renders as charts. The legacy module stays untouched.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import math
import os
import re
import socket
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.reports")

# --------------------------------------------------------------------------- #
# Paths + helpers
# --------------------------------------------------------------------------- #

_TS_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%d",
)

# Airodump "First time seen" timestamp format (UTC, naive).
_CSV_TS_FMT = "%Y-%m-%d %H:%M:%S"

# AI provider env-var keys → (API host, port) used by the preflight reachability
# probe. The first key found wins (OpenAI > Anthropic > Google > …).
_AI_PROVIDERS: list[tuple[str, str, int]] = [
    ("OPENAI_API_KEY", "api.openai.com", 443),
    ("ANTHROPIC_API_KEY", "api.anthropic.com", 443),
    ("GOOGLE_API_KEY", "generativelanguage.googleapis.com", 443),
    ("GEMINI_API_KEY", "generativelanguage.googleapis.com", 443),
    ("DEEPSEEK_API_KEY", "api.deepseek.com", 443),
    ("WARLOCK_AI_API_KEY", "", 0),  # generic — no known host
]

# Standard encryption buckets always present (0-filled) for deterministic output.
_ENC_BUCKETS = ("WPA3", "WPA2", "WPA3 WPA2", "Open", "WEP")
_PRIVACY_MAP = {"OPN": "Open", "": "Open", "OPEN": "Open"}


def _reports_dir() -> Path:
    d = get_settings().data / "reports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _captures_wifi_dir() -> Path:
    return get_settings().data / "captures" / "wifi"


def _tracks_dir() -> Path:
    return get_settings().data / "tracks"


def _aar_records_dir() -> Path:
    return get_settings().data / "aar" / "records"


def _parse_ts(value: str | None) -> datetime | None:
    """Parse a timestamp string into a naive UTC datetime (or None)."""
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    # ISO-8601 (incl. trailing Z) first.
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.replace(tzinfo=None)
    except ValueError:
        pass
    for fmt in _TS_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _parse_csv_ts(value: str) -> datetime | None:
    """Parse an airodump ``First time seen`` cell ("2026-06-03 21:56:01")."""
    if not value:
        return None
    s = value.strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, _CSV_TS_FMT)
    except ValueError:
        return None


def _today_bounds_utc() -> tuple[datetime, datetime]:
    now = datetime.utcnow()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1) - timedelta(seconds=1)


def _norm_privacy(raw: str) -> str:
    v = (raw or "").strip()
    return _PRIVACY_MAP.get(v.upper(), v)


def _to_int(value: Any, default: int | None = None) -> int | None:
    """Best-effort int parse of a possibly-padded / empty airodump cell."""
    if value is None:
        return default
    s = str(value).strip()
    if not s:
        return default
    try:
        return int(s)
    except ValueError:
        return default


def _five_min_bucket(dt: datetime) -> datetime:
    return dt.replace(minute=(dt.minute // 5) * 5, second=0, microsecond=0)


# --------------------------------------------------------------------------- #
# Airodump CSV parsing
# --------------------------------------------------------------------------- #

_AP_HEADER = "BSSID, First time seen"
_CLIENT_HEADER = "Station MAC,"


def _split_sections(text: str) -> tuple[list[list[str]], list[list[str]]]:
    """Split an airodump CSV into (ap_rows, client_rows) of stripped cells.

    The file is CRLF with trailing spaces, a leading blank line, and a blank
    line separating the AP block from the client block. We parse manually with
    :mod:`csv` per-section so malformed rows never abort the whole file.
    """
    # Normalise newlines then split on blank-line boundaries.
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    ap_lines: list[str] = []
    client_lines: list[str] = []
    in_clients = False
    for ln in lines:
        stripped = ln.strip()
        if stripped.startswith(_CLIENT_HEADER):
            in_clients = True
            continue
        if stripped.startswith(_AP_HEADER):
            in_clients = False
            continue
        if stripped == "":
            continue  # section separator / blank
        if in_clients:
            client_lines.append(ln)
        else:
            ap_lines.append(ln)

    def _rows(raw: list[str]) -> list[list[str]]:
        out: list[list[str]] = []
        for ln in raw:
            try:
                row = next(csv.reader(io.StringIO(ln)))
            except Exception:  # noqa: BLE001 — skip malformed lines
                continue
            # Strip every cell (airodump pads with spaces).
            row = [(c or "").strip() for c in row]
            if any(c for c in row):
                out.append(row)
        return out

    return _rows(ap_lines), _rows(client_lines)


def _parse_ap_row(row: list[str]) -> dict[str, Any] | None:
    """Parse a 15-column AP row → dict, or None if structurally invalid."""
    if len(row) < 14:
        return None
    try:
        return {
            "bssid": row[0],
            "first_seen": _parse_csv_ts(row[1]),
            "last_seen": _parse_csv_ts(row[2]),
            "channel": _to_int(row[3]),
            "speed": _to_int(row[4]),
            "privacy": row[5],
            "cipher": row[6],
            "auth": row[7],
            "power": _to_int(row[8]),
            "beacons": _to_int(row[9], 0) or 0,
            "iv": _to_int(row[10], 0) or 0,
            "essid": row[13] if len(row) > 13 else "",
        }
    except Exception:  # noqa: BLE001
        return None


def _parse_client_row(row: list[str]) -> dict[str, Any] | None:
    """Parse a 7-column client (station) row → dict, or None."""
    if len(row) < 6:
        return None
    try:
        return {
            "mac": row[0],
            "first_seen": _parse_csv_ts(row[1]),
            "last_seen": _parse_csv_ts(row[2]),
            "power": _to_int(row[3]),
            "packets": _to_int(row[4], 0) or 0,
            "bssid": row[5],
        }
    except Exception:  # noqa: BLE001
        return None


def _iter_airodump_csvs(d: Path):  # generator of Path
    if not d.is_dir():
        return
    for p in sorted(d.glob("airodump-*.csv")):
        if p.is_file():
            yield p


def _load_capture(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read one airodump CSV → (aps, clients). Empty/malformed → ([], [])."""
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return [], []
    ap_raw, client_raw = _split_sections(text)
    aps = [ap for ap in (_parse_ap_row(r) for r in ap_raw) if ap]
    clients = [c for c in (_parse_client_row(r) for r in client_raw) if c]
    return aps, clients


# --------------------------------------------------------------------------- #
# Wardrive aggregation
# --------------------------------------------------------------------------- #

def aggregate_wardrive_data(
    window_start: datetime | str | None,
    window_end: datetime | str | None,
) -> dict[str, Any]:
    """Aggregate all airodump-*.csv captures inside [window_start, window_end].

    Timestamps in the CSVs are naive UTC; window bounds are coerced to naive UTC.
    An AP counts when its ``First time seen`` falls inside the window.
    """
    ws = window_start if isinstance(window_start, datetime) else _parse_ts(window_start)
    we = window_end if isinstance(window_end, datetime) else _parse_ts(window_end)
    if ws is None or we is None:
        ws, we = _today_bounds_utc()

    aps: list[dict[str, Any]] = []
    clients: list[dict[str, Any]] = []
    for p in _iter_airodump_csvs(_captures_wifi_dir()):
        a, c = _load_capture(p)
        aps.extend(a)
        clients.extend(c)

    def _in_window(ts: datetime | None) -> bool:
        return ts is not None and ws <= ts <= we

    aps_w = [ap for ap in aps if _in_window(ap.get("first_seen"))]
    clients_w = [cl for cl in clients if _in_window(cl.get("first_seen"))]

    # Unique BSSIDs in window.
    bssid_set = {ap["bssid"] for ap in aps_w if ap.get("bssid")}

    # APs over time — 5-min buckets by first_seen.
    buckets: dict[datetime, int] = {}
    for ap in aps_w:
        ts = ap.get("first_seen")
        if ts is None:
            continue
        b = _five_min_bucket(ts)
        buckets[b] = buckets.get(b, 0) + 1
    aps_over_time = [
        {"ts": b.strftime("%H:%M"), "count": n}
        for b, n in sorted(buckets.items())
    ]

    # Encryption breakdown — standard buckets 0-filled + any extras.
    enc: dict[str, int] = {k: 0 for k in _ENC_BUCKETS}
    for ap in aps_w:
        norm = _norm_privacy(ap.get("privacy", ""))
        if not norm:
            norm = "Open"
        enc[norm] = enc.get(norm, 0) + 1

    # Channel distribution (skip non-positive channels).
    chan: dict[str, int] = {}
    for ap in aps_w:
        ch = ap.get("channel")
        if ch is None or ch <= 0:
            continue
        k = str(ch)
        chan[k] = chan.get(k, 0) + 1
    channel_distribution = dict(sorted(chan.items(), key=lambda kv: int(kv[0])))

    # Signal distribution — 10 dBm bins, strongest-first, skipping -1 (no signal).
    sig_bins: dict[int, int] = {}
    for ap in aps_w:
        p = ap.get("power")
        if p is None or p == -1 or p >= 0:
            continue
        floor = (p // 10) * 10  # e.g. -41 → -50
        sig_bins[floor] = sig_bins.get(floor, 0) + 1
    signal_distribution = [
        {"range": f"{floor + 10} to {floor}", "count": cnt}
        for floor, cnt in sorted(sig_bins.items(), reverse=True)
    ]

    # Top SSIDs — by distinct BSSID count.
    ssid_bssids: dict[str, set] = {}
    for ap in aps_w:
        essid = ap.get("essid") or "<hidden>"
        ssid_bssids.setdefault(essid, set()).add(ap.get("bssid", ""))
    top_ssids = [
        {"ssid": ssid, "count": len(bssids)}
        for ssid, bssids in sorted(
            ssid_bssids.items(), key=lambda kv: (-len(kv[1]), kv[0])
        )[:10]
    ]

    # Top clients — by packet count.
    client_pkts: dict[str, int] = {}
    for cl in clients_w:
        mac = cl.get("mac", "")
        if not mac:
            continue
        client_pkts[mac] = client_pkts.get(mac, 0) + (cl.get("packets") or 0)
    top_clients = [
        {"mac": mac, "packets": pkts}
        for mac, pkts in sorted(
            client_pkts.items(), key=lambda kv: (-kv[1], kv[0])
        )[:10]
    ]

    return {
        "window": {"start": ws.strftime(_CSV_TS_FMT), "end": we.strftime(_CSV_TS_FMT)},
        "total_aps": len(aps_w),
        "unique_bssids": len(bssid_set),
        "total_clients": len(clients_w),
        "aps_over_time": aps_over_time,
        "encryption_breakdown": enc,
        "channel_distribution": channel_distribution,
        "signal_distribution": signal_distribution,
        "top_ssids": top_ssids,
        "top_clients": top_clients,
    }


# --------------------------------------------------------------------------- #
# Engagement timeline (AAR records)
# --------------------------------------------------------------------------- #

def aggregate_engagement_timeline(
    window_start: datetime | str | None,
    window_end: datetime | str | None,
) -> dict[str, Any]:
    ws = window_start if isinstance(window_start, datetime) else _parse_ts(window_start)
    we = window_end if isinstance(window_end, datetime) else _parse_ts(window_end)
    if ws is None or we is None:
        ws, we = _today_bounds_utc()

    events: list[dict[str, Any]] = []
    d = _aar_records_dir()
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            try:
                rec = json.loads(p.read_text(errors="replace"))
            except Exception:  # noqa: BLE001
                continue
            ts = _parse_ts(rec.get("issued"))
            if ts is None or not (ws <= ts <= we):
                continue
            events.append({
                "ts": ts.strftime(_CSV_TS_FMT),
                "kind": rec.get("_kind", ""),
                "claim": (rec.get("task") or {}).get("claim", "")
                if isinstance(rec.get("task"), dict)
                else str(rec.get("task", "")),
                "verdict": rec.get("verdict", ""),
                "reason": rec.get("reason", ""),
                "file": p.name,
            })
    events.sort(key=lambda e: e["ts"])
    return {
        "window": {"start": ws.strftime(_CSV_TS_FMT), "end": we.strftime(_CSV_TS_FMT)},
        "event_count": len(events),
        "events": events,
    }


# --------------------------------------------------------------------------- #
# Loot inventory
# --------------------------------------------------------------------------- #

# (subdir, glob, type_label)
_LOOT_SCAN_RULES: list[tuple[str, str, str]] = [
    ("captures/wifi", "*.cap", "wifi_pcap"),
    ("captures/wifi", "*.csv", "wifi_csv"),
    ("captures/wifi", "*-geo.json", "wifi_geojson"),
    ("captures/wifi", "*.kml", "wifi_kml"),
    ("captures/wifi/exports", "*.csv", "wifi_export"),
    ("captures/wifi/cracked", "*", "cracked_hash"),
    ("handshakes", "*.pcap", "wifi_handshake"),
    ("handshakes", "*.cap", "wifi_handshake"),
    ("captures/sdr", "*.cu8", "sdr_iq"),
    ("captures/sdr", "*.cs8", "sdr_iq"),
    ("captures/sdr", "*.raw", "sdr_iq"),
    ("tracks", "*.gpx", "gps_track"),
    ("captures/test", "*.pcap", "net_pcap"),
    ("reports", "*.json", "report"),
    ("reports", "*.html", "report"),
    ("aar/records", "*.json", "aar_record"),
]
_LOOT_EXCLUDED = re.compile(r"\.log$|\.kismet$|^agent\.|\.mjs$|^\.", re.IGNORECASE)


def aggregate_loot_inventory(
    window_start: datetime | str | None,
    window_end: datetime | str | None,
) -> dict[str, Any]:
    ws = window_start if isinstance(window_start, datetime) else _parse_ts(window_start)
    we = window_end if isinstance(window_end, datetime) else _parse_ts(window_end)
    if ws is None or we is None:
        ws, we = _today_bounds_utc()

    root = get_settings().data
    by_type: dict[str, int] = {}
    by_type_size: dict[str, int] = {}
    total_files = 0
    total_size = 0
    seen: set[str] = set()
    for suffix, pattern, atype in _LOOT_SCAN_RULES:
        scan_dir = root / suffix
        if not scan_dir.is_dir():
            continue
        for p in sorted(scan_dir.glob(pattern)):
            if not p.is_file():
                continue
            rel = str(p.relative_to(root))
            if rel in seen or _LOOT_EXCLUDED.search(p.name):
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            seen.add(rel)
            mtime = datetime.utcfromtimestamp(st.st_mtime)
            if not (ws <= mtime <= we):
                continue
            by_type[atype] = by_type.get(atype, 0) + 1
            by_type_size[atype] = by_type_size.get(atype, 0) + st.st_size
            total_files += 1
            total_size += st.st_size
    return {
        "window": {"start": ws.strftime(_CSV_TS_FMT), "end": we.strftime(_CSV_TS_FMT)},
        "total_files": total_files,
        "total_size_bytes": total_size,
        "by_type": dict(sorted(by_type.items())),
        "by_type_size": dict(sorted(by_type_size.items())),
    }


# --------------------------------------------------------------------------- #
# GPS movement
# --------------------------------------------------------------------------- #

_GPX_NS = "{http://www.topografix.com/GPX/1/1}"
_MAX_COORDS = 2000  # cap rendered coordinates for payload sanity


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _parse_gpx_trackpoints(path: Path) -> list[dict[str, Any]]:
    """Return [{lat, lon, ele, time(datetime)}] for every trkpt in a GPX file."""
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return []
    pts: list[dict[str, Any]] = []
    for tp in root.iter(f"{_GPX_NS}trkpt"):
        lat = tp.get("lat")
        lon = tp.get("lon")
        if lat is None or lon is None:
            continue
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except ValueError:
            continue
        ele_el = tp.find(f"{_GPX_NS}ele")
        time_el = tp.find(f"{_GPX_NS}time")
        ele = None
        if ele_el is not None and ele_el.text:
            try:
                ele = float(ele_el.text)
            except ValueError:
                ele = None
        ts = None
        if time_el is not None and time_el.text:
            ts = _parse_ts(time_el.text)
        pts.append({"lat": lat_f, "lon": lon_f, "ele": ele, "time": ts})
    return pts


def aggregate_gps_movement(
    window_start: datetime | str | None,
    window_end: datetime | str | None,
) -> dict[str, Any]:
    ws = window_start if isinstance(window_start, datetime) else _parse_ts(window_start)
    we = window_end if isinstance(window_end, datetime) else _parse_ts(window_end)
    if ws is None or we is None:
        ws, we = _today_bounds_utc()

    d = _tracks_dir()
    all_pts: list[dict[str, Any]] = []
    track_files = 0
    if d.is_dir():
        for p in sorted(d.glob("*.gpx")):
            if not p.is_file():
                continue
            track_files += 1
            for pt in _parse_gpx_trackpoints(p):
                ts = pt.get("time")
                if ts is None or not (ws <= ts <= we):
                    continue
                all_pts.append(pt)

    coords = [[pt["lat"], pt["lon"]] for pt in all_pts]
    # Downsample if huge.
    if len(coords) > _MAX_COORDS:
        step = math.ceil(len(coords) / _MAX_COORDS)
        coords = coords[::step]

    # Distance + speed from full (un-downsampled) point sequence.
    distance_m = 0.0
    speeds: list[float] = []
    speed_profile: list[dict[str, Any]] = []
    for i in range(1, len(all_pts)):
        a, b = all_pts[i - 1], all_pts[i]
        seg = _haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        ta, tb = a.get("time"), b.get("time")
        if ta and tb:
            dt = (tb - ta).total_seconds()
            if dt > 0:
                sp = seg / dt
                speeds.append(sp)
                speed_profile.append({"ts": tb.strftime(_CSV_TS_FMT), "speed_mps": round(sp, 2)})
        distance_m += seg

    bounds = {
        "min_lat": min((p["lat"] for p in all_pts), default=0.0),
        "max_lat": max((p["lat"] for p in all_pts), default=0.0),
        "min_lon": min((p["lon"] for p in all_pts), default=0.0),
        "max_lon": max((p["lon"] for p in all_pts), default=0.0),
    }

    return {
        "window": {"start": ws.strftime(_CSV_TS_FMT), "end": we.strftime(_CSV_TS_FMT)},
        "track_files": track_files,
        "trackpoint_count": len(all_pts),
        "coordinates": coords,
        "bounds": bounds,
        "distance_m": round(distance_m, 2),
        "avg_speed_mps": round(sum(speeds) / len(speeds), 2) if speeds else 0.0,
        "max_speed_mps": round(max(speeds), 2) if speeds else 0.0,
        "speed_profile": speed_profile,
    }


# --------------------------------------------------------------------------- #
# Preflight
# --------------------------------------------------------------------------- #

def _find_ai_provider() -> tuple[str | None, str, int]:
    """Return (env_var_name, host, port) for the first configured AI provider."""
    for key, host, port in _AI_PROVIDERS:
        if (os.environ.get(key, "") or "").strip():
            return key, host, port
    return None, "", 0


def _tcp_reachable(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def run_preflight() -> dict[str, Any]:
    key, host, port = _find_ai_provider()
    ai_enabled = key is not None
    internet = _tcp_reachable("8.8.8.8", 53, timeout=3.0)
    api_accessible = bool(ai_enabled and host) and _tcp_reachable(host, port, timeout=3.0)
    return {
        "ai_enabled": ai_enabled,
        "internet": internet,
        "api_accessible": api_accessible,
        "all_pass": bool(ai_enabled and internet and api_accessible),
        "details": {
            "provider_key": key,
            "provider_host": host or None,
            "provider_port": port or None,
            "note": (
                "AI provider configured."
                if ai_enabled
                else "No AI provider API key found in environment."
            ),
        },
    }


# --------------------------------------------------------------------------- #
# Report generation dispatch
# --------------------------------------------------------------------------- #

_TEMPLATES: list[dict[str, str]] = [
    {"id": "wardrive_summary", "label": "Wardrive Summary", "icon": "📡",
     "description": "AP counts, signal distribution, channel utilization, encryption breakdown"},
    {"id": "engagement_timeline", "label": "Engagement Timeline", "icon": "⏱",
     "description": "Chronological events from AAR records, scope violations, module activity"},
    {"id": "loot_inventory", "label": "Loot Inventory", "icon": "💰",
     "description": "Artifact counts, disk usage, capture quality"},
    {"id": "gps_movement", "label": "GPS Movement", "icon": "🗺",
     "description": "Track map, speed profile, coverage area"},
]

_TEMPLATE_IDS = {t["id"] for t in _TEMPLATES}


def _resolve_window(
    engagement_id: str | None,
    window_start: str | None,
    window_end: str | None,
) -> tuple[datetime, datetime]:
    """Resolve the effective (start, end) window per the generate contract."""
    if window_start and window_end:
        ws, we = _parse_ts(window_start), _parse_ts(window_end)
        if ws and we:
            return ws, we
    if engagement_id:
        ws, we = _engagement_window(engagement_id)
        if ws and we:
            return ws, we
    return _today_bounds_utc()


def _engagement_window(engagement_id: str) -> tuple[datetime | None, datetime | None]:
    """Look up an engagement's started_at/ended_at (naive UTC) from the DB."""
    try:
        from warlock.db import session_scope
        from warlock.models import Engagement
    except Exception:  # noqa: BLE001 — DB optional in degraded runs
        return None, None
    try:
        with session_scope() as s:
            row = s.get(Engagement, engagement_id)
            if row is None:
                return None, None
            start = row.started_at
            end = row.ended_at or datetime.utcnow()
            return start, end
    except Exception:  # noqa: BLE001
        return None, None


def _generate(template_id: str, engagement_id: str | None,
              window_start: str | None, window_end: str | None) -> dict[str, Any]:
    ws, we = _resolve_window(engagement_id, window_start, window_end)
    if template_id == "wardrive_summary":
        data = aggregate_wardrive_data(ws, we)
    elif template_id == "engagement_timeline":
        data = aggregate_engagement_timeline(ws, we)
    elif template_id == "loot_inventory":
        data = aggregate_loot_inventory(ws, we)
    elif template_id == "gps_movement":
        data = aggregate_gps_movement(ws, we)
    else:
        raise HTTPException(404, f"unknown template: {template_id}")

    rid = f"rpt-{int(time.time())}-{template_id}-{uuid4().hex[:6]}"
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report = {
        "report_id": rid,
        "template": template_id,
        "engagement_id": engagement_id,
        "window": {"start": ws.strftime(_CSV_TS_FMT), "end": we.strftime(_CSV_TS_FMT)},
        "data": data,
        "generated_at": generated_at,
    }
    try:
        (_reports_dir() / f"{rid}.json").write_text(json.dumps(report, indent=2, default=str))
    except OSError as e:  # best-effort persist; report still returned
        log.warning("could not persist report %s: %s", rid, e)
    return report


# --------------------------------------------------------------------------- #
# HTTP layer
# --------------------------------------------------------------------------- #

class GenerateBody(BaseModel):
    engagement_id: str | None = None
    window_start: str | None = None
    window_end: str | None = None


class ClientReportBody(BaseModel):
    engagement_id: str | None = None
    window_start: str | None = None
    window_end: str | None = None
    client_name: str = ""
    operator_name: str = "TechMages"
    use_ai: bool = True
    findings: list[dict[str, Any]] = []
    notes: str = ""


_CLIENT_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{
    --bg: #ffffff; --fg: #1a1a2e; --muted: #6b7280;
    --accent: #4f46e5; --border: #e5e7eb; --card: #f9fafb;
    --sev-crit: #dc2626; --sev-high: #ea580c; --sev-med: #ca8a04; --sev-low: #16a34a;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'Segoe UI', system-ui, sans-serif; color: var(--fg); background: var(--bg); line-height: 1.6; }}
  .header {{ padding: 2rem 2rem 1rem; border-bottom: 2px solid var(--accent); }}
  .header h1 {{ color: var(--accent); font-size: 1.5rem; }}
  .header .meta {{ color: var(--muted); font-size: 0.9rem; margin-top: 0.5rem; }}
  .content {{ padding: 2rem; max-width: 900px; margin: 0 auto; }}
  .section {{ margin-bottom: 2rem; }}
  .section h2 {{ color: var(--accent); font-size: 1.15rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }}
  .stat-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1rem; }}
  .stat-card {{ background: var(--card); border-radius: 8px; padding: 1rem; border: 1px solid var(--border); }}
  .stat-card .val {{ font-size: 1.75rem; font-weight: 700; color: var(--accent); }}
  .stat-card .lbl {{ font-size: 0.8rem; color: var(--muted); text-transform: uppercase; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.9rem; }}
  th, td {{ text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid var(--border); }}
  th {{ background: var(--card); font-weight: 600; }}
  .sev {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; color: white; }}
  .sev-Critical {{ background: var(--sev-crit); }}
  .sev-High {{ background: var(--sev-high); }}
  .sev-Medium {{ background: var(--sev-med); }}
  .sev-Low {{ background: var(--sev-low); }}
  .narrative {{ background: var(--card); border-left: 3px solid var(--accent); padding: 1rem 1.5rem; border-radius: 0 8px 8px 0; white-space: pre-wrap; }}
  .footer {{ padding: 1rem 2rem; color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--border); margin-top: 2rem; }}
</style>
</head>
<body>
{header}
<div class="content">
{stats}
{findings}
{narrative}
{methodology}
</div>
<div class="footer">
  Generated by Warlock OS · {generated_at}<br>
  This document contains sanitized, non-attributable assessment data.
</div>
</body>
</html>"""


def _generate_client_report(body: ClientReportBody) -> dict[str, Any]:
    """Generate a client-facing engagement report (HTML + JSON)."""
    pref = run_preflight()

    # Determine engagement window
    eid = body.engagement_id
    if eid:
        w_start, w_end = _engagement_window(eid)
    else:
        w_start = _parse_ts(body.window_start) or _today_bounds_utc()[0]
        w_end = _parse_ts(body.window_end) or _today_bounds_utc()[1]

    # Aggregate wardrive data for stats via existing generators
    wd = _generate("wardrive_summary", eid, body.window_start, body.window_end)
    loot = _generate("loot_inventory", eid, body.window_start, body.window_end)
    timeline = _generate("engagement_timeline", eid, body.window_start, body.window_end)

    total_aps = wd.get("unique_bssids", 0)
    total_clients = wd.get("total_clients", 0)
    enc = wd.get("encryption", {})
    open_count = enc.get("Open", 0)
    wpa3_count = enc.get("WPA3", 0)

    # Build stat cards
    stats_html = f"""
    <div class="section">
      <h2>Assessment Summary</h2>
      <div class="stat-grid">
        <div class="stat-card"><div class="val">{total_aps}</div><div class="lbl">Access Points Discovered</div></div>
        <div class="stat-card"><div class="val">{total_clients}</div><div class="lbl">Client Devices Observed</div></div>
        <div class="stat-card"><div class="val">{open_count}</div><div class="lbl">Open Networks</div></div>
        <div class="stat-card"><div class="val">{wpa3_count}</div><div class="lbl">WPA3 Networks</div></div>
      </div>
    </div>"""

    # Build findings table
    findings_rows = ""
    all_findings = list(body.findings)
    if open_count > 0:
        all_findings.append({
            "title": f"{open_count} open (unencrypted) wireless networks discovered",
            "severity": "High",
            "description": "Open networks expose traffic to interception. Any client connecting to these APs transmits in cleartext.",
            "recommendation": "Implement WPA2/WPA3 encryption on all access points. Use VPN tunnels when connecting to untrusted networks.",
        })
    if wpa3_count == 0 and total_aps > 5:
        all_findings.append({
            "title": "No WPA3 networks detected in assessment area",
            "severity": "Low",
            "description": "All discovered networks use older encryption standards. WPA3 provides enhanced protection against offline dictionary attacks.",
            "recommendation": "Plan migration to WPA3 where hardware supports it.",
        })

    for f in all_findings:
        sev = f.get("severity", "Low")
        findings_rows += f"""
        <tr>
          <td><span class="sev sev-{sev}">{sev}</span></td>
          <td><strong>{f.get("title", "")}</strong><br><span style="color:var(--muted);font-size:0.85rem">{f.get("description", "")}</span></td>
          <td>{f.get("recommendation", "")}</td>
        </tr>"""

    findings_html = f"""
    <div class="section">
      <h2>Findings &amp; Recommendations</h2>
      <table>
        <thead><tr><th>Severity</th><th>Finding</th><th>Recommendation</th></tr></thead>
        <tbody>{findings_rows}</tbody>
      </table>
    </div>""" if findings_rows else ""

    # AI-assisted narrative
    narrative_text = ""
    ai_used = False
    if body.use_ai and pref["all_pass"]:
        try:
            narrative_text = _call_ai_for_narrative(
                total_aps, total_clients, open_count, wpa3_count, body.notes, all_findings
            )
            ai_used = True
        except Exception as e:
            log.warning("AI narrative generation failed: %s", e)
            narrative_text = _fallback_narrative(
                total_aps, total_clients, open_count, wpa3_count, body.notes
            )
    else:
        narrative_text = _fallback_narrative(
            total_aps, total_clients, open_count, wpa3_count, body.notes
        )

    narrative_html = f"""
    <div class="section">
      <h2>Assessment Narrative{" (AI-Assisted)" if ai_used else ""}</h2>
      <div class="narrative">{narrative_text}</div>
    </div>"""

    methodology_html = """
    <div class="section">
      <h2>Methodology</h2>
      <p>Assessment conducted using passive wireless reconnaissance (802.11 monitor mode).
      No active exploitation, deauthentication, or credential harvesting was performed during this engagement.
      All data was collected from broadcast frames within the authorized assessment scope.</p>
    </div>"""

    # Build the full HTML document
    client = body.client_name or "Assessment Scope"
    title = f"Wireless Security Assessment — {client}"
    generated_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    w_start_str = (w_start or _today_bounds_utc()[0]).strftime("%Y-%m-%d %H:%M")
    w_end_str = (w_end or _today_bounds_utc()[1]).strftime("%Y-%m-%d %H:%M")
    header_html = f"""
    <div class="header">
      <h1>{title}</h1>
      <div class="meta">
        <strong>Prepared by:</strong> {body.operator_name}<br>
        <strong>Assessment Window:</strong> {w_start_str} – {w_end_str} UTC<br>
        <strong>Engagement ID:</strong> {eid or "ad-hoc"}
      </div>
    </div>"""

    html = _CLIENT_HTML_TEMPLATE.format(
        title=title,
        header=header_html,
        stats=stats_html,
        findings=findings_html,
        narrative=narrative_html,
        methodology=methodology_html,
        generated_at=generated_at,
    )

    # Save the report
    report_id = f"client-{int(time.time())}"
    reports_dir = _reports_dir()
    html_path = reports_dir / f"{report_id}.html"
    json_path = reports_dir / f"{report_id}.json"
    html_path.write_text(html, encoding="utf-8")

    meta = {
        "template": "client_facing",
        "report_id": report_id,
        "engagement_id": eid,
        "client_name": client,
        "operator_name": body.operator_name,
        "window": {"start": (w_start or _today_bounds_utc()[0]).isoformat(), "end": (w_end or _today_bounds_utc()[1]).isoformat()},
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "ai_used": ai_used,
        "preflight": pref,
        "stats": {"aps": total_aps, "clients": total_clients, "open": open_count, "wpa3": wpa3_count},
        "findings_count": len(all_findings),
        "html_path": str(html_path),
    }
    json_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {"ok": True, "report_id": report_id, "html": html, "meta": meta}


def _call_ai_for_narrative(
    aps: int, clients: int, open_nets: int, wpa3: int,
    notes: str, findings: list[dict[str, Any]],
) -> str:
    """Call the configured AI provider to generate a professional narrative."""
    import urllib.request

    key, host, _ = _find_ai_provider()
    if not key:
        raise RuntimeError("No AI API key configured")

    findings_summary = "\n".join(
        f"  - [{f.get('severity', 'Low')}] {f.get('title', '')}"
        for f in findings[:10]
    )

    prompt = f"""Write a professional executive summary for a wireless security assessment.
Do NOT use markdown formatting. Write in plain paragraphs. Be factual and concise.

Key metrics:
- Access points discovered: {aps}
- Client devices observed: {clients}
- Open/unencrypted networks: {open_nets}
- WPA3 networks: {wpa3}

Findings:
{findings_summary}

Operator notes: {notes or 'None provided'}

Write a 3-4 paragraph executive summary covering:
1. Overview of what was assessed
2. Key findings and risk posture
3. Notable observations
4. High-level recommendations"""

    # OpenAI-compatible API call
    data = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "You are a professional security consultant writing a client report."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 800,
        "temperature": 0.7,
    }).encode()

    req = urllib.request.Request(
        f"https://{host}/v1/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {os.environ.get(key, '')}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
        return result["choices"][0]["message"]["content"].strip()


def _fallback_narrative(
    aps: int, clients: int, open_nets: int, wpa3: int, notes: str,
) -> str:
    """Generate a professional narrative without AI — template-based."""
    risk = "elevated" if open_nets > 5 else "moderate" if open_nets > 0 else "low"

    return f"""A wireless security assessment was conducted covering the designated operational area. During the assessment window, {aps} unique wireless access points and {clients} client devices were observed through passive monitoring.

The overall risk posture is {risk}. {"Of particular concern, " + str(open_nets) + " open (unencrypted) networks were discovered, exposing wireless traffic to passive interception by any party within radio range." if open_nets > 0 else "No open or unencrypted networks were detected, indicating baseline encryption practices are in place."} {("WPA3-protected networks were present, showing adoption of current wireless security standards." if wpa3 > 0 else "No WPA3 networks were detected; all discovered networks rely on older WPA2 or earlier encryption standards.")}

All data was collected passively through 802.11 monitor mode. No active exploitation, deauthentication attacks, or credential harvesting was performed. The assessment scope was limited to wireless signals observable from the assessment vantage point.

Recommendations include implementing WPA3 where hardware permits, securing or decommissioning open networks, and ensuring wireless clients use VPN tunnels when connecting to untrusted infrastructure.{" Additional operator notes: " + notes if notes else ""}"""


class Module(ModuleBase):
    id = "reports"
    label = "Reports"
    icon = "📊"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/templates")
        def templates_ep() -> dict[str, Any]:
            return {"templates": list(_TEMPLATES)}

        @r.post("/generate/{template_id}")
        def generate_ep(template_id: str, body: GenerateBody) -> dict[str, Any]:
            if template_id not in _TEMPLATE_IDS:
                raise HTTPException(404, f"unknown template: {template_id}")
            return _generate(template_id, body.engagement_id, body.window_start, body.window_end)

        @r.get("/list")
        def list_ep() -> dict[str, Any]:
            reports: list[dict[str, Any]] = []
            d = _reports_dir()
            for p in sorted(d.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:100]:
                entry: dict[str, Any] = {
                    "id": p.stem,
                    "mtime": int(p.stat().st_mtime),
                    "size_bytes": p.stat().st_size,
                }
                # Best-effort metadata from the JSON body.
                try:
                    doc = json.loads(p.read_text(errors="replace"))
                    if isinstance(doc, dict):
                        entry["template"] = doc.get("template")
                        entry["engagement_id"] = doc.get("engagement_id")
                        entry["generated_at"] = doc.get("generated_at")
                        entry["window"] = doc.get("window")
                except Exception:  # noqa: BLE001
                    pass
                reports.append(entry)
            return {"ok": True, "count": len(reports), "reports": reports}

        @r.post("/preflight")
        def preflight_ep() -> dict[str, Any]:
            return run_preflight()

        @r.post("/client")
        def client_report_ep(body: ClientReportBody) -> dict[str, Any]:
            return _generate_client_report(body)

        return r
