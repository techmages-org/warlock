"""Wireless IDS TUI screen — live detections + start/stop.

Mirrors the web Blue page against the SAME module APIs:
  GET  /api/wireless_ids/status       running + iface + kismet reachability
  POST /api/wireless_ids/start         {channels, iface}
  POST /api/wireless_ids/stop
  GET  /api/wireless_ids/detections    rogue-AP / evil-twin / deauth-flood / kismet alerts

Defensive (blue-team) monitor — NOT engagement-gated.
"""
from __future__ import annotations

from typing import Any

import httpx
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal
from textual.widget import Widget
from textual.widgets import (
    Button,
    DataTable,
    Input,
    Label,
    Static,
)

from warlock.tui.widgets.tile import Tile

_SEV_COLOR = {"critical": "red", "high": "red", "medium": "yellow", "low": "cyan", "info": "dim"}


class WirelessIdsScreen(Widget):
    DEFAULT_CSS = """
    WirelessIdsScreen { padding: 1 2; }
    #wi-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #wi-ctrl  { height: 3; padding: 0 0; }
    #wi-dets  { height: 24; }
    Button.danger { background: $error; }
    """

    POLL = 3.0

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
        yield Label("[b]Wireless IDS[/]  —  kismet rogue-AP / evil-twin / deauth-flood watch")
        yield Grid(id="wi-tiles")
        with Horizontal(id="wi-ctrl"):
            yield Label("channels ")
            yield Input(value="all", id="inp-channels")
            yield Button("▶ START", id="btn-start")
            yield Button("■ STOP", id="btn-stop", classes="danger")
            yield Static("  ", id="wi-note")
        yield DataTable(zebra_stripes=True, id="wi-dets")

    async def on_mount(self) -> None:
        grid = self.query_one("#wi-tiles", Grid)
        for key, title in [
            ("state", "State"),
            ("iface", "Iface"),
            ("kismet", "Kismet"),
            ("dets", "Detections"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        self.query_one("#wi-dets", DataTable).add_columns(
            "type", "sev", "SSID", "BSSID", "CH", "SIG", "detail"
        )
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=4.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict | None = None) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=15.0) as c:
            r = await c.post(f"{self.api_url}{path}", json=body or {})
            r.raise_for_status()
            return r.json()

    async def _refresh(self) -> None:
        try:
            st = await self._get("/api/wireless_ids/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["state"].update_values("err", str(e), severity="err")
            return
        running = bool(st.get("running"))
        self._tiles["state"].update_values(
            "WATCHING" if running else "idle",
            f"uptime {st.get('uptime_s') or 0}s" if running else "",
            severity="ok" if running else "warn",
        )
        allow = st.get("allowlist") or {}
        self._tiles["iface"].update_values(
            st.get("iface") or "—",
            f"ch {st.get('channels') or '—'} · allow {allow.get('ssids', 0)}s/{allow.get('bssids', 0)}b",
        )
        reachable = bool(st.get("kismet_reachable"))
        self._tiles["kismet"].update_values(
            "reachable" if reachable else "—", "", severity="ok" if reachable else "warn"
        )
        self.query_one("#btn-start", Button).disabled = running
        self.query_one("#btn-stop", Button).disabled = not running

        try:
            d = await self._get("/api/wireless_ids/detections")
        except Exception:  # noqa: BLE001
            self._tiles["dets"].update_values("—", "(idle)")
            return
        counts = d.get("counts") or {}
        self._tiles["dets"].update_values(
            str(d.get("count") or 0),
            f"rogue {counts.get('rogue_ap', 0)} · twin {counts.get('evil_twin', 0)} · "
            f"deauth {counts.get('deauth_flood', 0)}",
            severity="err" if d.get("count") else "ok",
        )
        tbl = self.query_one("#wi-dets", DataTable)
        tbl.clear()
        for det in d.get("detections", [])[:80]:
            sev = det.get("severity") or "info"
            col = _SEV_COLOR.get(sev, "dim")
            tbl.add_row(
                det.get("type") or "",
                f"[{col}]{sev}[/]",
                (det.get("ssid") or "—")[:20],
                det.get("bssid") or "—",
                str(det.get("channel") or ""),
                str(det.get("signal") or ""),
                (det.get("detail") or "")[:48],
            )

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        note = self.query_one("#wi-note", Static)
        try:
            if ev.button.id == "btn-start":
                channels = self.query_one("#inp-channels", Input).value.strip() or "all"
                d = await self._post("/api/wireless_ids/start", {"channels": channels})
                note.update(f"  [green]started[/] {d.get('state', {}).get('iface', '')}")
            elif ev.button.id == "btn-stop":
                await self._post("/api/wireless_ids/stop")
                note.update("  [yellow]stopped[/]")
        except httpx.HTTPStatusError as e:
            note.update(f"  [red]{e.response.status_code}: {(e.response.text or '')[:160]}[/]")
        except Exception as e:  # noqa: BLE001
            note.update(f"  [red]error: {e}[/]")
        await self._refresh()
