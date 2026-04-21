"""Abstract base class every module implements."""
from __future__ import annotations

from abc import ABC, abstractmethod

from fastapi import APIRouter


class ModuleBase(ABC):
    id: str = ""  # url-safe slug (matches module filename)
    label: str = ""  # human display name
    icon: str = "●"  # single glyph for TUI + web nav
    requires_engagement: bool = False
    requires_root: bool = False

    @abstractmethod
    def router(self) -> APIRouter:
        """Return a FastAPI router mounted automatically by the server."""

    def tui_screen(self):  # type: ignore[no-untyped-def]
        """Return a Textual Screen instance for this module's TUI tab."""
        from warlock.tui.screens.stub import StubScreen

        return StubScreen(module_id=self.id, label=self.label)

    async def on_startup(self) -> None:  # noqa: B027 — optional hook
        pass

    async def on_shutdown(self) -> None:  # noqa: B027 — optional hook
        pass
