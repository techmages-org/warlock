"""Top-of-screen banner: GREEN SAFE / RED ENGAGED / YELLOW LOADING."""
from __future__ import annotations

import httpx
from textual.reactive import reactive
from textual.widgets import Static


class EngagementBanner(Static):
    """Polls /api/engagements/active every 2s."""

    POLL_SECONDS = 2.0

    status: reactive[dict] = reactive({"mode": "loading"})

    def __init__(self, *, api_url: str, auth: tuple[str, str] | None = None, **kw) -> None:
        super().__init__("", id="engagement-banner", **kw)
        self.api_url = api_url.rstrip("/")
        self.auth = auth

    def on_mount(self) -> None:
        self.update(self._render(self.status))
        self.set_interval(self.POLL_SECONDS, self._refresh)

    async def _refresh(self) -> None:
        try:
            async with httpx.AsyncClient(auth=self.auth, timeout=2.0) as c:
                r = await c.get(f"{self.api_url}/api/engagements/active")
                r.raise_for_status()
                self.status = r.json()
        except Exception:  # noqa: BLE001
            self.status = {"mode": "loading", "error": True}
        self.update(self._render(self.status))

    def _render(self, st: dict) -> str:
        mode = st.get("mode", "loading")
        if mode == "on":
            scope = st.get("scope") or {}
            scope_summary = (
                f"SSIDs:{len(scope.get('ssids', []))}  "
                f"BSSIDs:{len(scope.get('bssids', []))}  "
                f"IPs:{len(scope.get('ip_ranges', []))}"
            )
            self.set_class(True, "engaged")
            return f"[b white on red] ⚠  ENGAGED — {st.get('name', '')}  [{scope_summary}][/]"
        if mode == "off":
            self.set_class(True, "safe")
            return "[b white on green] ✓  SAFE — engagement mode OFF [/]"
        self.set_class(True, "loading")
        return "[b black on yellow] … loading engagement status [/]"
