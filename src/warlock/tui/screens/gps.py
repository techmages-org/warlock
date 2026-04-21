"""GPS TUI screen — Fix / Sky / Time / Tracks tabs, 1 Hz refresh."""
from __future__ import annotations

import asyncio
import math
from typing import Any

import httpx
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal, Vertical, VerticalScroll
from textual.widget import Widget
from textual.widgets import Button, DataTable, Label, Static, TabbedContent, TabPane

from warlock.tui.widgets.tile import Tile


class GpsScreen(Widget):
    DEFAULT_CSS = """
    GpsScreen { padding: 1 2; }
    #fix-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #waiting-banner { padding: 0 1; background: $warning 40%; color: $text; text-style: bold; }
    #sky-plot { border: round $accent; padding: 0 1; height: 18; width: 100%; }
    #sat-table { height: 12; }
    #track-table { height: 14; }
    #track-controls { height: 3; padding: 0 0; }
    #time-tiles { grid-size: 3; grid-gutter: 1 1; height: auto; }
    #refclocks { border: round $accent; padding: 0 1; height: auto; min-height: 5; }
    Button.recording { background: $error; }
    """

    POLL_SECONDS = 1.0
    SLOW_POLL = 3.0

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
        yield Label("[b]GPS[/]  —  live fix · sky · chrony · tracks")
        yield Static("", id="waiting-banner")
        with TabbedContent(initial="fix"):
            with TabPane("Fix", id="fix"):
                yield Grid(id="fix-tiles")
            with TabPane("Sky", id="sky"):
                yield Static("awaiting SKY frame…", id="sky-plot")
                yield DataTable(zebra_stripes=True, id="sat-table")
            with TabPane("Time", id="time"):
                yield Grid(id="time-tiles")
                yield Static("", id="refclocks")
            with TabPane("Tracks", id="tracks"):
                with Horizontal(id="track-controls"):
                    yield Button("▶ Start recording", id="btn-start")
                    yield Button("■ Stop recording", id="btn-stop", disabled=True)
                    yield Static("  ", id="rec-status")
                yield DataTable(zebra_stripes=True, id="track-table")

    async def on_mount(self) -> None:
        # Fix tiles
        grid = self.query_one("#fix-tiles", Grid)
        for key, title in [
            ("fix", "Fix mode"),
            ("lat", "Latitude"),
            ("lon", "Longitude"),
            ("alt", "Altitude (m)"),
            ("speed", "Speed (m/s)"),
            ("heading", "Heading"),
            ("hdop", "HDOP"),
            ("sats", "Sats used/seen"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        # Time tiles
        tgrid = self.query_one("#time-tiles", Grid)
        for key, title in [
            ("stratum", "Stratum"),
            ("offset", "Last offset (ms)"),
            ("pps", "PPS (/dev/pps0)"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            tgrid.mount(t)
        # Tables
        sat_tbl = self.query_one("#sat-table", DataTable)
        sat_tbl.add_columns("PRN", "const", "elev", "az", "SNR", "used")
        trk_tbl = self.query_one("#track-table", DataTable)
        trk_tbl.add_columns("filename", "started", "duration(s)", "points", "size")

        await self._refresh_fix()
        await self._refresh_tracks()
        self.set_interval(self.POLL_SECONDS, self._refresh_fix)
        self.set_interval(self.SLOW_POLL, self._refresh_time)
        self.set_interval(self.SLOW_POLL, self._refresh_tracks)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
            r = await c.post(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _delete(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
            r = await c.delete(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _refresh_fix(self) -> None:
        try:
            fix = await self._get("/api/gps/fix")
            sats = await self._get("/api/gps/sats")
        except Exception as e:  # noqa: BLE001
            self.query_one("#waiting-banner", Static).update(f"[err] gps api: {e}")
            return
        mode = fix.get("mode", 0)
        banner = self.query_one("#waiting-banner", Static)
        if not fix.get("ok"):
            banner.update(f"[warn] {fix.get('reason', 'gpsd offline')}")
        elif mode < 2:
            banner.update("⚠ waiting for fix — no sky view yet (expected indoors)")
        else:
            banner.update(f"✓ {mode}D fix · {fix.get('satellites_used', '?')} sats used")
        self._tiles["fix"].update_values(
            f"{mode}D" if mode >= 2 else "no fix",
            fix.get("time") or "",
            severity="ok" if mode >= 2 else "warn",
        )
        self._tiles["lat"].update_values(
            f"{fix.get('lat'):.6f}" if fix.get("lat") is not None else "—",
        )
        self._tiles["lon"].update_values(
            f"{fix.get('lon'):.6f}" if fix.get("lon") is not None else "—",
        )
        self._tiles["alt"].update_values(
            f"{fix.get('alt'):.1f}" if fix.get("alt") is not None else "—",
        )
        self._tiles["speed"].update_values(
            f"{fix.get('speed_mps'):.2f}" if fix.get("speed_mps") is not None else "—",
        )
        self._tiles["heading"].update_values(
            f"{fix.get('track_deg'):.0f}°" if fix.get("track_deg") is not None else "—",
        )
        self._tiles["hdop"].update_values(
            f"{fix.get('hdop')}" if fix.get("hdop") is not None else "—",
        )
        self._tiles["sats"].update_values(
            f"{fix.get('satellites_used', '?')}/{fix.get('satellites_seen', '?')}",
        )
        self._render_sky(sats)

    def _render_sky(self, sats_resp: dict[str, Any]) -> None:
        sats = sats_resp.get("satellites") or []
        plot = self._polar_ascii(sats, radius=8)
        self.query_one("#sky-plot", Static).update(plot)
        tbl = self.query_one("#sat-table", DataTable)
        tbl.clear()
        for s in sats[:24]:
            tbl.add_row(
                str(s.get("prn") or "?"),
                str(s.get("constellation") or "?"),
                f"{s.get('elevation')}" if s.get("elevation") is not None else "—",
                f"{s.get('azimuth')}" if s.get("azimuth") is not None else "—",
                f"{s.get('snr')}" if s.get("snr") is not None else "—",
                "✓" if s.get("used") else "",
            )

    @staticmethod
    def _polar_ascii(sats: list[dict[str, Any]], radius: int = 8) -> str:
        """Zenith at centre, N up. Each sat plotted as a glyph coloured by SNR."""
        w = radius * 2 + 1
        h = radius + 1  # terminal cells are ~2:1 — keep compact
        grid = [[" " for _ in range(w * 2)] for _ in range(h * 2)]
        cx = radius * 2
        cy = h
        # Draw circles (90, 60, 30 degree rings).
        for ring in (radius, int(radius * 2 / 3), int(radius / 3)):
            for theta in range(0, 360, 8):
                rad = math.radians(theta)
                x = int(cx + ring * 2 * math.cos(rad))
                y = int(cy - ring * math.sin(rad))
                if 0 <= x < w * 2 and 0 <= y < h * 2:
                    if grid[y][x] == " ":
                        grid[y][x] = "·"
        # Cardinals
        for label, (dx, dy) in [("N", (0, -1)), ("S", (0, 1)), ("E", (1, 0)), ("W", (-1, 0))]:
            x = cx + int(dx * radius * 2)
            y = cy + int(dy * radius)
            if 0 <= x < w * 2 and 0 <= y < h * 2:
                grid[y][x] = f"[b]{label}[/]"
        for s in sats:
            el = s.get("elevation")
            az = s.get("azimuth")
            if el is None or az is None:
                continue
            r = (90 - max(0, min(90, el))) / 90.0 * radius
            rad = math.radians(az)
            x = int(cx + r * 2 * math.sin(rad))
            y = int(cy - r * math.cos(rad))
            if not (0 <= x < w * 2 and 0 <= y < h * 2):
                continue
            snr = s.get("snr") or 0
            colour = "red" if snr < 15 else "yellow" if snr < 30 else "green"
            glyph = "●" if s.get("used") else "○"
            grid[y][x] = f"[{colour}]{glyph}[/]"
        return "\n".join("".join(row) for row in grid)

    async def _refresh_time(self) -> None:
        try:
            d = await self._get("/api/gps/time")
        except Exception:  # noqa: BLE001
            return
        t = d.get("tracking") or {}
        refs = d.get("refclocks") or []
        pps = d.get("pps") or {}
        self._tiles["stratum"].update_values(
            f"{t.get('stratum', '—')}",
            t.get("reference_id") or "",
            severity="ok" if t.get("ok") else "warn",
        )
        offs = t.get("last_offset_s")
        self._tiles["offset"].update_values(
            f"{offs * 1000:.3f}" if isinstance(offs, (int, float)) else "—",
            f"rms {t.get('rms_offset_s', '—')} s" if t.get("rms_offset_s") is not None else "",
        )
        pps_present = pps.get("present")
        pps_pulsing = pps.get("pulsing")
        val = "yes" if pps_present else "no"
        sev = "ok" if pps_present else "warn"
        sub = (
            "pulsing" if pps_pulsing else ("quiet" if pps_present else "device missing")
        )
        self._tiles["pps"].update_values(val, sub, severity=sev)
        lines = ["[dim]chrony refclocks[/]"]
        for r in refs:
            lines.append(
                f"{r.get('source'):<4} stratum {r.get('stratum')}  "
                f"reach {r.get('reach_octal')}  "
                f"last_rx {r.get('last_rx')}  offset {r.get('last_sample')}"
            )
        if not refs:
            lines.append("(no GPS/PPS refclocks reporting yet — expected when mode<2)")
        self.query_one("#refclocks", Static).update("\n".join(lines))

    async def _refresh_tracks(self) -> None:
        try:
            d = await self._get("/api/gps/tracks")
        except Exception:  # noqa: BLE001
            return
        rec = d.get("recording") or {}
        active = bool(rec.get("active"))
        self.query_one("#btn-start", Button).disabled = active
        self.query_one("#btn-stop", Button).disabled = not active
        stat = self.query_one("#rec-status", Static)
        if active:
            stat.update(f"[b green]● REC[/] {rec.get('filename')} ({rec.get('points', 0)} pts)")
        else:
            stat.update("[dim]not recording[/]")
        tbl = self.query_one("#track-table", DataTable)
        tbl.clear()
        for row in d.get("tracks", []):
            tbl.add_row(
                row.get("filename", ""),
                (row.get("started_at") or "")[:19],
                str(row.get("duration_s") or "—"),
                str(row.get("points") or 0),
                f"{(row.get('size_bytes') or 0) // 1024} KB",
            )

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        if ev.button.id == "btn-start":
            try:
                await self._post("/api/gps/tracks/start")
            except Exception as e:  # noqa: BLE001
                self.app.notify(f"start failed: {e}", severity="error")
            await self._refresh_tracks()
        elif ev.button.id == "btn-stop":
            try:
                await self._post("/api/gps/tracks/stop")
            except Exception as e:  # noqa: BLE001
                self.app.notify(f"stop failed: {e}", severity="error")
            await self._refresh_tracks()
