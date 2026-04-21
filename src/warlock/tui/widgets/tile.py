"""Reusable dashboard tile."""
from __future__ import annotations

from textual.widgets import Static


class Tile(Static):
    """Small bordered card with a title + value + optional subtitle."""

    def __init__(self, title: str, value: str = "…", subtitle: str = "", *, severity: str = "ok") -> None:
        body = self._format(title, value, subtitle)
        super().__init__(body, classes=severity)
        self._title = title

    def update_values(self, value: str, subtitle: str = "", severity: str = "ok") -> None:
        # Refresh classes: strip existing severity tags.
        for s in ("ok", "warn", "err"):
            self.remove_class(s)
        self.add_class(severity)
        self.update(self._format(self._title, value, subtitle))

    @staticmethod
    def _format(title: str, value: str, subtitle: str) -> str:
        out = f"[b]{title}[/]\n[b cyan]{value}[/]"
        if subtitle:
            out += f"\n[dim]{subtitle}[/]"
        return out
