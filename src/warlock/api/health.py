"""Health + version endpoints — always unauthed."""
from __future__ import annotations

import time

from fastapi import APIRouter

from warlock import __version__

router = APIRouter(tags=["meta"])
_BOOTED_AT = time.time()


@router.get("/api/health")
def health() -> dict:
    return {"ok": True, "uptime_s": round(time.time() - _BOOTED_AT, 1)}


@router.get("/api/version")
def version() -> dict:
    return {"name": "warlock", "version": __version__}
