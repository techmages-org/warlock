"""Loot — unified artifact browser and downloader.

  GET  /api/loot                          — typed artifact index (filterable)
  GET  /api/loot/download/{path:path}     — single-file download (path-safe)
  POST /api/loot/archive                  — zip-on-the-fly bulk download
  DELETE /api/loot/{path:path}            — delete a single artifact

Scans all known artifact directories under the data root and presents a
unified, typed, sortable list — the "grab the loot" surface.
"""
from __future__ import annotations

import io
import logging
import mimetypes
import re
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.loot")

# --- artifact-type detection -------------------------------------------------

# (directory_suffix, glob, artifact_type, module, excluded_patterns)
# Order matters: first match wins (more specific patterns first).
_SCAN_RULES: list[tuple[str, str, str, str, tuple[str, ...]]] = [
    # wifi recon captures
    ("captures/wifi", "*.cap", "wifi_pcap", "wifi_recon", ()),
    ("captures/wifi", "*.csv", "wifi_csv", "wifi_recon", ()),
    ("captures/wifi", "*-geo.json", "wifi_geojson", "wifi_recon", ()),
    ("captures/wifi", "*.kml", "wifi_kml", "wifi_recon", ()),
    ("captures/wifi/exports", "*.csv", "wifi_export_csv", "wifi_recon", ()),
    ("captures/wifi/exports", "*.kml", "wifi_export_kml", "wifi_recon", ()),
    ("captures/wifi/cracked", "*", "cracked_hash", "crack", ()),
    # wifi offensive
    ("handshakes", "*.pcap", "wifi_handshake", "wifi_offensive", ()),
    ("handshakes", "*.cap", "wifi_handshake", "wifi_offensive", ()),
    # SDR
    ("captures/sdr", "*.cu8", "sdr_iq", "sdr_offensive", ()),
    ("captures/sdr", "*.cs8", "sdr_iq", "sdr_offensive", ()),
    ("captures/sdr", "*.raw", "sdr_iq", "sdr_offensive", ()),
    # GPS
    ("tracks", "*.gpx", "gps_track", "gps", ()),
    # net capture
    ("captures/test", "*.pcap", "net_pcap", "capture", ()),
    # reports
    ("reports", "*.html", "report", "report", ()),
    ("reports", "*.json", "report", "report", ()),
    # AAR records
    ("aar/records", "*.json", "aar_record", "aar", ()),
    # walk test
    ("walktest", "*.json", "walk_test", "wifi_analyzer", ()),
    # WIDS
    ("wireless_ids", "*.log", "wids_log", "wireless_ids", ()),
    ("wireless_ids", "*.csv", "wids_log", "wireless_ids", ()),
]

# Extensions / patterns to ALWAYS exclude from scan results.
_EXCLUDED = re.compile(
    r"\.log$"          # airodump log files (can be 800GB+)
    r"|\.kismet$"
    r"|^agent\."
    r"|\.mjs$"
    r"|^\.",           # dotfiles
    re.IGNORECASE,
)

# Cache the scan so we don't hammer the filesystem on every request.
_SCAN_CACHE: dict[str, Any] = {}
_CACHE_TTL = 5.0  # seconds


def _classify(path: Path, rel: str) -> tuple[str, str] | None:
    """Return (artifact_type, module) for a path, or None to skip."""
    for suffix, pattern, atype, module, _excl in _SCAN_RULES:
        if not rel.startswith(suffix):
            continue
        if path.match(pattern):
            if _EXCLUDED.search(path.name):
                return None
            return atype, module
    return None


def _scan_artifacts(data_root: Path) -> list[dict[str, Any]]:
    """Walk the data root and build the artifact list."""
    artifacts: list[dict[str, Any]] = []
    seen_paths: set[str] = set()

    for suffix, pattern, atype, module, _excl in _SCAN_RULES:
        scan_dir = data_root / suffix
        if not scan_dir.is_dir():
            continue
        for p in sorted(scan_dir.iterdir(), key=lambda x: x.stat().st_mtime if x.is_file() else 0, reverse=True):
            if not p.is_file():
                continue
            rel = str(p.relative_to(data_root))
            if rel in seen_paths:
                continue
            if _EXCLUDED.search(p.name):
                continue
            if not p.match(pattern):
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            seen_paths.add(rel)
            artifacts.append({
                "id": p.stem,
                "type": atype,
                "module": module,
                "path": rel,
                "name": p.name,
                "size_bytes": st.st_size,
                "created_at": st.st_mtime,
                "download_url": f"/api/loot/download/{rel}",
            })
    return artifacts


def _get_artifacts(data_root: Path) -> list[dict[str, Any]]:
    """Return cached artifact scan (TTL-bounded)."""
    cache_key = str(data_root)
    now = time.time()
    cached = _SCAN_CACHE.get(cache_key)
    if cached and (now - cached["ts"]) < _CACHE_TTL:
        return cached["data"]
    fresh = _scan_artifacts(data_root)
    _SCAN_CACHE[cache_key] = {"ts": now, "data": fresh}
    return fresh


def _safe_path(data_root: Path, rel: str) -> Path:
    """Resolve *rel* under *data_root*; raise 400 on traversal."""
    # Normalise and strip leading slashes
    clean = rel.lstrip("/")
    resolved = (data_root / clean).resolve()
    try:
        resolved.relative_to(data_root.resolve())
    except ValueError:
        raise HTTPException(400, "path traversal denied")  # noqa: B904
    return resolved


class ArchiveBody(BaseModel):
    paths: list[str] = Field(default_factory=list, description="Relative paths to zip")
    engagement_id: str | None = Field(default=None, description="Zip all artifacts from this engagement")


class Module(ModuleBase):
    id = "loot"
    label = "Loot"
    icon = "💰"
    requires_engagement = False

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/loot", tags=["loot"])

        @r.get("")
        def index(
            type: str | None = None,
            module: str | None = None,
            engagement_id: str | None = None,
            since: float | None = None,
        ) -> dict[str, Any]:
            """Typed artifact index, filterable."""
            settings = get_settings()
            data_root = settings.data
            artifacts = _get_artifacts(data_root)

            # filters
            if type:
                artifacts = [a for a in artifacts if a["type"] == type]
            if module:
                artifacts = [a for a in artifacts if a["module"] == module]
            if since:
                artifacts = [a for a in artifacts if a["created_at"] >= since]
            if engagement_id:
                # Filter by engagement time window
                eng_dir = settings.engagement_dir() / engagement_id
                if eng_dir.is_dir():
                    import yaml
                    yml = eng_dir / "engagement.yaml"
                    if yml.exists():
                        meta = yaml.safe_load(yml.read_text()) or {}
                        started = meta.get("started_at_ts")
                        ended = meta.get("ended_at_ts")
                        if started:
                            lo = float(started)
                            hi = float(ended) if ended else time.time()
                            artifacts = [a for a in artifacts if lo <= a["created_at"] <= hi]

            # summary
            by_type: dict[str, dict[str, int]] = {}
            total = 0
            for a in artifacts:
                t = a["type"]
                if t not in by_type:
                    by_type[t] = {"count": 0, "size_bytes": 0}
                by_type[t]["count"] += 1
                by_type[t]["size_bytes"] += a["size_bytes"]
                total += a["size_bytes"]

            return {
                "ok": True,
                "artifacts": artifacts,
                "count": len(artifacts),
                "total_size_bytes": total,
                "by_type": by_type,
            }

        @r.get("/download/{file_path:path}")
        def download(file_path: str) -> FileResponse:
            """Download a single artifact by relative path."""
            data_root = get_settings().data
            full = _safe_path(data_root, file_path)
            if not full.is_file():
                raise HTTPException(404, "artifact not found")
            media, _ = mimetypes.guess_type(str(full))
            return FileResponse(
                str(full),
                media_type=media or "application/octet-stream",
                filename=full.name,
            )

        @r.post("/archive")
        def archive(body: ArchiveBody) -> StreamingResponse:
            """Zip-on-the-fly for bulk download."""
            data_root = get_settings().data
            # Resolve paths
            to_zip: list[Path] = []
            for rel in body.paths:
                full = _safe_path(data_root, rel)
                if full.is_file():
                    to_zip.append(full)
            if not to_zip:
                raise HTTPException(400, "no valid files to archive")

            def generate() -> Any:
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                    for p in to_zip:
                        arcname = p.name if len(to_zip) == 1 else str(p.relative_to(data_root))
                        zf.write(p, arcname)
                buf.seek(0)
                yield from buf

            return StreamingResponse(
                generate(),
                media_type="application/zip",
                headers={"Content-Disposition": "attachment; filename=loot.zip"},
            )

        @r.delete("/{file_path:path}")
        def delete(file_path: str) -> dict[str, Any]:
            """Delete a single artifact."""
            data_root = get_settings().data
            full = _safe_path(data_root, file_path)
            if not full.is_file():
                raise HTTPException(404, "artifact not found")
            size = full.stat().st_size
            full.unlink()
            # Invalidate cache
            _SCAN_CACHE.pop(str(data_root), None)
            log.info("loot: deleted %s (%d bytes)", file_path, size)
            return {"ok": True, "deleted": file_path, "size_bytes": size}

        return r
