"""Dashboard TUI screen — live tiles off /api/dashboard/status."""
from __future__ import annotations

import httpx
from textual.app import ComposeResult
from textual.containers import Grid
from textual.widget import Widget
from textual.widgets import Label

from warlock.tui.widgets.tile import Tile


class DashboardScreen(Widget):
    DEFAULT_CSS = """
    DashboardScreen { padding: 1 2; }
    #tiles { grid-size: 4; grid-gutter: 1 1; }
    """

    POLL_SECONDS = 2.0

    def __init__(self, *, api_url: str, auth: tuple[str, str] | None = None) -> None:
        super().__init__()
        self.api_url = api_url.rstrip("/")
        self.auth = auth
        self._tiles: dict[str, Tile] = {}

    def compose(self) -> ComposeResult:
        yield Label("[b]Dashboard[/]  —  live telemetry")
        yield Grid(id="tiles")

    async def on_mount(self) -> None:
        grid = self.query_one("#tiles", Grid)
        for key, title in [
            ("cpu", "CPU"),
            ("temp", "Temp"),
            ("disk", "Disk /"),
            ("chrony", "NTP"),
            ("gps", "GPS"),
            ("mesh", "Mesh"),
            ("sdr", "SDR"),
            ("engagement", "Engagement"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        await self._refresh()
        self.set_interval(self.POLL_SECONDS, self._refresh)

    async def _refresh(self) -> None:
        try:
            async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
                r = await c.get(f"{self.api_url}/api/dashboard/status")
                r.raise_for_status()
                d = r.json()
        except Exception as e:  # noqa: BLE001
            for t in self._tiles.values():
                t.update_values("err", str(e), severity="err")
            return

        cpu = d.get("cpu", {})
        self._tiles["cpu"].update_values(
            f"{cpu.get('percent', '?')}%",
            f"load {cpu.get('load_1m')} / {cpu.get('load_5m')} / {cpu.get('load_15m')}",
        )
        temp = d.get("temp_c")
        sev = "ok" if (temp is None or temp < 70) else "warn" if temp < 80 else "err"
        self._tiles["temp"].update_values(
            f"{temp}°C" if temp is not None else "n/a",
            d.get("throttled") or "",
            severity=sev,
        )
        free_mb = d.get("disk_root_mb_free")
        pct = d.get("disk_root_percent")
        self._tiles["disk"].update_values(
            f"{free_mb} MB free",
            f"{pct}% used",
            severity="warn" if (pct or 0) > 85 else "ok",
        )
        ch = d.get("chrony", {})
        self._tiles["chrony"].update_values(
            f"stratum {ch.get('stratum', '?')}" if ch.get("ok") else "offline",
            f"offset {ch.get('offset_s', '?')}s",
            severity="ok" if ch.get("ok") else "warn",
        )
        gps = d.get("gps", {})
        if gps.get("ok") and gps.get("mode", 0) >= 2:
            self._tiles["gps"].update_values(
                f"fix {gps.get('mode')}D",
                f"lat {gps.get('lat')} lon {gps.get('lon')}",
                severity="ok",
            )
        else:
            self._tiles["gps"].update_values(
                "no fix",
                gps.get("reason", ""),
                severity="warn",
            )
        mn = d.get("mesh_node_count")
        self._tiles["mesh"].update_values(
            f"{mn} nodes" if mn is not None else "offline",
            "",
            severity="ok" if mn is not None else "warn",
        )
        sdr = d.get("sdr", {})
        self._tiles["sdr"].update_values(
            f"{sdr.get('count', '?')} dev" if sdr.get("ok") else "n/a",
            sdr.get("reason", ""),
            severity="ok" if sdr.get("ok") else "warn",
        )
        eng = d.get("engagement", {})
        self._tiles["engagement"].update_values(
            "ENGAGED" if eng.get("mode") == "on" else "SAFE",
            eng.get("name", ""),
            severity="err" if eng.get("mode") == "on" else "ok",
        )
