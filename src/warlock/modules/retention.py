"""Capture retention — configurable auto-purge of oversized/old capture files.

  GET  /api/retention/status    — current disk usage + purgeable breakdown
  POST /api/retention/purge     — execute purge now (dry-run by default)
  GET  /api/retention/config    — current thresholds
  PUT  /api/retention/config    — update thresholds

Strategy:
  - .log files from airodump-ng are verbose stdout captures that balloon to
    hundreds of GB. They have zero analytical value — the .csv, .cap, and
    .geo.json siblings contain all the useful data. Always purge candidates.
  - .cap (pcap) files are valuable but large. Purge by age (default 30d).
  - .csv, .json, .kml, .pcap, .hc22000 are small and always kept.
  - Configurable via WARLOCK_RETENTION_LOG_MAX_MB, WARLOCK_RETENTION_CAP_MAX_AGE_DAYS,
    WARLOCK_RETENTION_DRY_RUN env vars or the API.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.retention")

# File categories
PURGE_ALWAYS = {".log"}          # airodump verbose logs — pure bloat
PURGE_BY_AGE = {".cap"}          # packet captures — valuable but large
KEEP_ALWAYS = {".csv", ".json", ".kml", ".pcap", ".hc22000", ".geojson"}


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


def _file_age_days(path: Path) -> float:
    return (time.time() - path.stat().st_mtime) / 86400.0


class RetentionConfig(BaseModel):
    log_max_mb: int = Field(default=1, description="Purge .log files larger than this (MB). Default 1 = effectively all.")
    cap_max_age_days: int = Field(default=30, description="Purge .cap files older than this (days).")
    dry_run: bool = Field(default=True, description="If true, only report what would be purged.")


# Module-level config (persisted in memory, loaded from env on startup)
_config = RetentionConfig(
    log_max_mb=int(getattr(get_settings(), "retention_log_max_mb", 1)),
    cap_max_age_days=int(getattr(get_settings(), "retention_cap_max_age_days", 30)),
    dry_run=bool(getattr(get_settings(), "retention_dry_run", True)),
)


def _captures_dir() -> Path:
    return get_settings().data / "captures"


def _scan_purgeable(cfg: RetentionConfig) -> list[dict[str, Any]]:
    """Return list of files that match purge criteria."""
    cap_dir = _captures_dir()
    if not cap_dir.exists():
        return []

    purgeable: list[dict[str, Any]] = []
    for f in cap_dir.rglob("*"):
        if not f.is_file():
            continue
        ext = f.suffix.lower()
        size_mb = f.stat().st_size / (1024 * 1024)
        age_days = _file_age_days(f)

        reason = None
        if ext in PURGE_ALWAYS and size_mb > cfg.log_max_mb:
            reason = "oversized .log"
        elif ext in PURGE_BY_AGE and age_days > cfg.cap_max_age_days:
            reason = f".cap older than {cfg.cap_max_age_days}d"

        if reason:
            purgeable.append({
                "path": str(f.relative_to(cap_dir)),
                "ext": ext,
                "size_bytes": f.stat().st_size,
                "size_human": _human_size(f.stat().st_size),
                "age_days": round(age_days, 1),
                "reason": reason,
            })

    return purgeable


def _disk_usage() -> dict[str, Any]:
    """Get disk usage for the capture partition."""
    cap_dir = _captures_dir()
    if not cap_dir.exists():
        return {"total_bytes": 0, "used_bytes": 0, "free_bytes": 0, "pct": 0}

    # Use shutil.disk_usage on the captures path
    import shutil
    total, used, free = shutil.disk_usage(cap_dir)
    return {
        "total_bytes": total,
        "used_bytes": used,
        "free_bytes": free,
        "total_human": _human_size(total),
        "used_human": _human_size(used),
        "free_human": _human_size(free),
        "pct": round(used / total * 100, 1) if total else 0,
    }


def _captures_breakdown() -> dict[str, dict[str, Any]]:
    """Size + count by file extension under captures/."""
    cap_dir = _captures_dir()
    if not cap_dir.exists():
        return {}

    by_ext: dict[str, dict[str, Any]] = {}
    for f in cap_dir.rglob("*"):
        if not f.is_file():
            continue
        ext = f.suffix.lower() or "(none)"
        if ext not in by_ext:
            by_ext[ext] = {"count": 0, "size_bytes": 0}
        by_ext[ext]["count"] += 1
        by_ext[ext]["size_bytes"] += f.stat().st_size
        by_ext[ext]["size_human"] = _human_size(by_ext[ext]["size_bytes"])

    return dict(sorted(by_ext.items(), key=lambda x: x[1]["size_bytes"], reverse=True))


class RetentionModule(ModuleBase):
    id: str = "retention"
    label: str = "Retention"
    icon: str = "⊘"

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/retention", tags=["retention"])

        @r.get("/status")
        def get_status() -> dict[str, Any]:
            """Disk usage + purgeable files + breakdown by type."""
            purgeable = _scan_purgeable(_config)
            total_purgeable = sum(f["size_bytes"] for f in purgeable)
            return {
                "disk": _disk_usage(),
                "breakdown": _captures_breakdown(),
                "purgeable": purgeable,
                "purgeable_count": len(purgeable),
                "purgeable_bytes": total_purgeable,
                "purgeable_human": _human_size(total_purgeable),
                "config": _config.model_dump(),
            }

        @r.post("/purge")
        def do_purge(confirm: bool = False) -> dict[str, Any]:
            """Execute purge. Requires confirm=true to actually delete."""
            purgeable = _scan_purgeable(_config)
            cap_dir = _captures_dir()

            if _config.dry_run and not confirm:
                return {
                    "action": "dry_run",
                    "would_delete": len(purgeable),
                    "would_free": _human_size(sum(f["size_bytes"] for f in purgeable)),
                    "message": "Dry-run mode. Pass confirm=true to execute.",
                    "files": purgeable,
                }

            deleted = []
            freed_bytes = 0
            errors = []

            for item in purgeable:
                fpath = cap_dir / item["path"]
                try:
                    size = fpath.stat().st_size
                    fpath.unlink()
                    freed_bytes += size
                    deleted.append(item["path"])
                    log.info("purged %s (%s)", item["path"], _human_size(size))
                except Exception as e:
                    errors.append({"path": item["path"], "error": str(e)})

            return {
                "action": "executed",
                "deleted_count": len(deleted),
                "freed_bytes": freed_bytes,
                "freed_human": _human_size(freed_bytes),
                "deleted": deleted,
                "errors": errors,
                "disk_after": _disk_usage(),
            }

        @r.get("/config")
        def get_config() -> dict[str, Any]:
            return _config.model_dump()

        @r.put("/config")
        def update_config(
            log_max_mb: int | None = None,
            cap_max_age_days: int | None = None,
            dry_run: bool | None = None,
        ) -> dict[str, Any]:
            global _config
            new = _config.model_copy(update={
                k: v for k, v in {
                    "log_max_mb": log_max_mb,
                    "cap_max_age_days": cap_max_age_days,
                    "dry_run": dry_run,
                }.items() if v is not None
            })
            _config = new
            log.info("retention config updated: %s", _config.model_dump())
            return _config.model_dump()

        return r


Module = RetentionModule
