"""Maps module — Mapbox integration for wardriving maps and pin drops.

Endpoints:
  GET  /api/maps/config    — Mapbox API key, style, tile URL template
  GET  /api/maps/wardrive  — GPS track points + AP data for map rendering
  POST /api/maps/geojson   — Export wardrive data as GeoJSON for external tools
"""
from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import get_settings
from ..modules._base import ModuleBase

_GPX_NS = "{http://www.topografix.com/GPX/1/1}"
_CSV_TS_FMT = "%Y-%m-%d %H:%M:%S"
_TS_FORMATS = (
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d",
)


def _tracks_dir() -> Path:
    return get_settings().data / "tracks"


def _captures_wifi_dir() -> Path:
    return get_settings().data / "captures" / "wifi"


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
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


def _parse_ap_row(row: list[str]) -> dict[str, Any] | None:
    """Parse an airodump AP CSV row into a dict."""
    if len(row) < 14:
        return None
    try:
        return {
            "bssid": row[0].strip(),
            "first_seen": _parse_ts(row[1].strip()),
            "last_seen": _parse_ts(row[2].strip()),
            "channel": int(row[3].strip()) if row[3].strip().lstrip("-").isdigit() else 0,
            "privacy": row[5].strip(),
            "power": int(row[8].strip()) if row[8].strip().lstrip("-").isdigit() else 0,
            "beacons": int(row[9].strip()) if row[9].strip().isdigit() else 0,
            "essid": row[13].strip(),
        }
    except (ValueError, IndexError):
        return None


def _split_sections(text: str) -> tuple[list[list[str]], list[list[str]]]:
    """Split airodump CSV into AP rows and client rows."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    sections: list[list[list[str]]] = [[], []]
    idx = 0
    for ln in lines:
        if ln.lower().startswith("station mac"):
            idx = 1
            continue
        if ln.lower().startswith("bssid"):
            continue
        parts = [p.strip() for p in ln.split(",")]
        sections[idx].append(parts)
    return sections[0], sections[1]


def _load_aps(path: Path) -> list[dict[str, Any]]:
    """Load AP entries from a single airodump CSV."""
    try:
        raw = path.read_text(errors="replace")
    except OSError:
        return []
    ap_rows, _ = _split_sections(raw)
    aps: list[dict[str, Any]] = []
    for row in ap_rows:
        ap = _parse_ap_row(row)
        if ap:
            aps.append(ap)
    return aps


def _parse_gpx_trackpoints(path: Path) -> list[dict[str, Any]]:
    """Return [{lat, lon, ele, time}] for every trkpt in a GPX file."""
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
                pass
        ts = None
        if time_el is not None and time_el.text:
            ts = _parse_ts(time_el.text)
        pts.append({"lat": lat_f, "lon": lon_f, "ele": ele, "time": ts})
    return pts


def _correlate_aps_with_gps(
    aps: list[dict[str, Any]],
    track: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Correlate AP sightings with GPS positions by nearest timestamp.

    For each AP, find the GPS trackpoint closest in time to the AP's first_seen.
    Returns APs enriched with lat/lon where a trackpoint was found within
    CORRELATION_WINDOW seconds.
    """
    if not track or not aps:
        return aps

    # Sort track by time for binary search
    timed_track = [(p["time"], p) for p in track if p.get("time")]
    timed_track.sort(key=lambda x: x[0])

    WINDOW = 30  # seconds — AP gets GPS if a trackpoint exists within this window

    import bisect

    times = [t for t, _ in timed_track]

    for ap in aps:
        ap_ts = ap.get("first_seen")
        if not ap_ts:
            continue
        # Find closest trackpoint by time
        idx = bisect.bisect_left(times, ap_ts)
        best = None
        best_diff = abs(timedelta.max.total_seconds())
        for i in (idx - 1, idx):
            if 0 <= i < len(timed_track):
                diff = abs((ap_ts - timed_track[i][0]).total_seconds())
                if diff < best_diff:
                    best_diff = diff
                    best = timed_track[i][1]
        if best and best_diff <= WINDOW:
            ap["lat"] = best["lat"]
            ap["lon"] = best["lon"]

    return aps


class WardriveBody(BaseModel):
    engagement_id: str | None = None
    window_start: str | None = None
    window_end: str | None = None
    max_points: int = 5000


class GeoJSONBody(BaseModel):
    engagement_id: str | None = None
    window_start: str | None = None
    window_end: str | None = None


def _gather_wardrive_data(
    engagement_id: str | None = None,
    window_start: str | None = None,
    window_end: str | None = None,
    max_points: int = 5000,
) -> dict[str, Any]:
    """Gather GPS track points and correlated AP data for map rendering."""
    ws = _parse_ts(window_start)
    we = _parse_ts(window_end)

    # Load all GPS tracks
    tracks_dir = _tracks_dir()
    all_points: list[dict[str, Any]] = []
    for gpx in sorted(tracks_dir.glob("*.gpx")):
        pts = _parse_gpx_trackpoints(gpx)
        # Filter by window if specified
        for p in pts:
            if ws and p.get("time") and p["time"] < ws:
                continue
            if we and p.get("time") and p["time"] > we:
                continue
            all_points.append(p)

    # Cap points for payload sanity
    if len(all_points) > max_points:
        step = len(all_points) / max_points
        all_points = [all_points[int(i * step)] for i in range(max_points)]

    # Load APs from all airodump CSVs
    caps_dir = _captures_wifi_dir()
    all_aps: list[dict[str, Any]] = []
    for csv in sorted(caps_dir.glob("*.csv")):
        aps = _load_aps(csv)
        # Filter by window
        for ap in aps:
            if ws and ap.get("first_seen") and ap["first_seen"] < ws:
                continue
            if we and ap.get("first_seen") and ap["first_seen"] > we:
                continue
            all_aps.append(ap)

    # Deduplicate APs by BSSID (keep strongest signal)
    seen: dict[str, dict[str, Any]] = {}
    for ap in all_aps:
        bssid = ap.get("bssid", "")
        if bssid in ("", "00:00:00:00:00:00"):
            continue
        if bssid not in seen or ap.get("power", -999) > seen[bssid].get("power", -999):
            seen[bssid] = ap
    unique_aps = list(seen.values())

    # Correlate APs with GPS track for positions
    correlated = _correlate_aps_with_gps(unique_aps, all_points)
    geo_aps = [ap for ap in correlated if "lat" in ap and "lon" in ap]

    # Compute bounds
    lats = [p["lat"] for p in all_points] + [ap["lat"] for ap in geo_aps]
    lons = [p["lon"] for p in all_points] + [ap["lon"] for ap in geo_aps]
    bounds = None
    if lats and lons:
        bounds = {
            "min_lat": min(lats), "max_lat": max(lats),
            "min_lon": min(lons), "max_lon": max(lons),
        }

    return {
        "track_points": len(all_points),
        "ap_total": len(unique_aps),
        "ap_geolocated": len(geo_aps),
        "bounds": bounds,
        "track": [{"lat": p["lat"], "lon": p["lon"]} for p in all_points],
        "aps": [
            {
                "bssid": ap["bssid"],
                "essid": ap.get("essid", ""),
                "channel": ap.get("channel", 0),
                "privacy": ap.get("privacy", ""),
                "power": ap.get("power", 0),
                "lat": ap["lat"],
                "lon": ap["lon"],
            }
            for ap in geo_aps
        ],
    }


class Module(ModuleBase):
    id = "maps"
    label = "Maps"
    icon = "🗺"

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/config")
        def config_ep() -> dict[str, Any]:
            """Return Mapbox config for the frontend."""
            settings = get_settings()
            key = settings.mapbox_api_key
            style = settings.mapbox_style
            return {
                "has_key": bool(key),
                "api_key": key,
                "style": style,
                "tile_url": (
                    f"https://api.mapbox.com/styles/v1/{style}/tiles/256/{{z}}/{{x}}/{{y}}@2x?access_token={key}"
                    if key else ""
                ),
                # Fallback tiles (no key required) — CARTO dark matter
                "fallback_tile_url": "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
            }

        @r.get("/wardrive")
        def wardrive_ep(
            engagement_id: str | None = None,
            window_start: str | None = None,
            window_end: str | None = None,
            max_points: int = 5000,
        ) -> dict[str, Any]:
            return _gather_wardrive_data(
                engagement_id=engagement_id,
                window_start=window_start,
                window_end=window_end,
                max_points=max_points,
            )

        @r.post("/geojson")
        def geojson_ep(body: GeoJSONBody) -> dict[str, Any]:
            """Export wardrive data as GeoJSON FeatureCollection."""
            data = _gather_wardrive_data(
                engagement_id=body.engagement_id,
                window_start=body.window_start,
                window_end=body.window_end,
            )

            features: list[dict[str, Any]] = []

            # Track as a LineString
            if data["track"]:
                features.append({
                    "type": "Feature",
                    "properties": {"type": "track", "points": data["track_points"]},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[p["lon"], p["lat"]] for p in data["track"]],
                    },
                })

            # APs as points
            for ap in data["aps"]:
                features.append({
                    "type": "Feature",
                    "properties": {
                        "type": "ap",
                        "bssid": ap["bssid"],
                        "essid": ap["essid"],
                        "channel": ap["channel"],
                        "privacy": ap["privacy"],
                        "power": ap["power"],
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": [ap["lon"], ap["lat"]],
                    },
                })

            geojson = {
                "type": "FeatureCollection",
                "features": features,
            }

            # Save export
            export_dir = get_settings().data / "exports"
            export_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            export_path = export_dir / f"wardrive-{ts}.geojson"
            export_path.write_text(json.dumps(geojson, indent=2), encoding="utf-8")

            return {
                "ok": True,
                "path": str(export_path),
                "features": len(features),
                "geojson": geojson,
            }

        return r
