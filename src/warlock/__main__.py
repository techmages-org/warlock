"""`python -m warlock` → run the FastAPI server."""
from __future__ import annotations

import argparse

import uvicorn

from warlock.config import get_settings


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser("warlock")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    uvicorn.run(
        "warlock.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
