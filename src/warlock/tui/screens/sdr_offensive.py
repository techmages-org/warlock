"""Offensive SDR TUI screen — thin status view for the 1-route stub module.

Mirrors the module's single endpoint:
  GET /api/sdr_offensive/status   -> {module, label, status: "pending", todo: [...]}

RTL-SDR is RX-only, so this module is intentionally a stub (TX needs HackRF).
The screen surfaces its status + the roadmap TODO list rather than faking ops.
"""
from __future__ import annotations

from typing import Any

import httpx
from textual.app import ComposeResult
from textual.containers import Grid
from textual.widget import Widget
from textual.widgets import Label, RichLog

from warlock.tui.widgets.tile import Tile


class SdrOffensiveScreen(Widget):
    DEFAULT_CSS = """
    SdrOffensiveScreen { padding: 1 2; }
    #so-tiles { grid-size: 3; grid-gutter: 1 1; height: auto; }
    #so-todo  { height: 18; }
    """

    POLL = 5.0

    def __init__(
        self,
        *,
        api_url: str = "http://127.0.0.1:7777",
        auth: tuple[str, str] | None = None,
    ) -> None:
        super().__init__()
        self.api_url = api_url.rstrip("/")
        self.auth = auth
        self._tiles: dict[str, Tile] = {}

    def compose(self) -> ComposeResult:
        yield Label("[b]Offensive SDR[/]  —  ☢ replay / signal analysis (pending — RTL-SDR is RX-only)")
        yield Grid(id="so-tiles")
        yield Label("[b]Roadmap[/] — deferred until TX-capable hardware (HackRF/LimeSDR) arrives")
        yield RichLog(id="so-todo", markup=True, wrap=True)

    async def on_mount(self) -> None:
        grid = self.query_one("#so-tiles", Grid)
        for key, title in [("status", "Status"), ("gate", "Engagement"), ("label", "Module")]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=4.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _refresh(self) -> None:
        try:
            st = await self._get("/api/sdr_offensive/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["status"].update_values("err", str(e), severity="err")
            return
        self._tiles["status"].update_values(st.get("status") or "—", "", severity="warn")
        self._tiles["gate"].update_values(
            "required" if st.get("requires_engagement") else "no", "", severity="warn"
        )
        self._tiles["label"].update_values(st.get("label") or st.get("module") or "—", st.get("module") or "")
        log = self.query_one("#so-todo", RichLog)
        log.clear()
        todo = st.get("todo") or st.get("todo_items") or []
        if not todo:
            log.write("[dim](no roadmap items reported)[/]")
        for item in todo:
            log.write(f"  • {item}")
