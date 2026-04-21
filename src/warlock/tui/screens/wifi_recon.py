"""WiFi Recon TUI screen — APs / Clients / Handshakes / Control."""
from __future__ import annotations

from typing import Any

import httpx
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import (
    Button,
    DataTable,
    Input,
    Label,
    Static,
    TabbedContent,
    TabPane,
)

from warlock.tui.widgets.tile import Tile


class WifiReconScreen(Widget):
    DEFAULT_CSS = """
    WifiReconScreen { padding: 1 2; }
    #wr-tiles   { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #wr-control { height: auto; padding: 0 0; }
    #wr-aps, #wr-clients, #wr-hands { height: 22; }
    Button.danger { background: $error; }
    """

    POLL = 2.0

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
        yield Label("[b]WiFi Recon[/]  —  passive airodump-ng on MT7921")
        yield Grid(id="wr-tiles")
        with TabbedContent(initial="aps"):
            with TabPane("APs", id="aps"):
                yield DataTable(zebra_stripes=True, id="wr-aps")
            with TabPane("Clients", id="clients"):
                yield DataTable(zebra_stripes=True, id="wr-clients")
            with TabPane("Handshakes", id="hands"):
                yield DataTable(zebra_stripes=True, id="wr-hands")
            with TabPane("Control", id="control"):
                with Vertical(id="wr-control"):
                    yield Label("channels (all / 2.4 / 5 / comma-list)")
                    yield Input(value="all", id="inp-channels")
                    with Horizontal():
                        yield Button("▶ START SCAN", id="btn-start")
                        yield Button("■ STOP SCAN", id="btn-stop", disabled=True)
                    yield Static("", id="wr-note")

    async def on_mount(self) -> None:
        grid = self.query_one("#wr-tiles", Grid)
        for key, title in [
            ("state", "State"),
            ("iface", "Iface"),
            ("aps", "APs"),
            ("clients", "Clients"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        tbl = self.query_one("#wr-aps", DataTable)
        tbl.add_columns("BSSID", "ESSID", "CH", "ENC", "SIG", "BEAC", "FIRST")
        ctbl = self.query_one("#wr-clients", DataTable)
        ctbl.add_columns("STA", "AP", "PWR", "PKT", "PROBES")
        htbl = self.query_one("#wr-hands", DataTable)
        htbl.add_columns("file", "size", "EAPOL", "mtime")
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
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
            st = await self._get("/api/wifi_recon/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["state"].update_values("err", str(e), severity="err")
            return
        running = bool(st.get("running"))
        self._tiles["state"].update_values(
            "SCANNING" if running else "idle",
            f"uptime {st.get('uptime_s') or 0}s" if running else "",
            severity="ok" if running else "warn",
        )
        self._tiles["iface"].update_values(st.get("iface") or "—", st.get("channels") or "")
        self._tiles["aps"].update_values(str(st.get("aps_seen") or 0))
        self._tiles["clients"].update_values(str(st.get("clients_seen") or 0))
        self.query_one("#btn-start", Button).disabled = running
        self.query_one("#btn-stop", Button).disabled = not running

        try:
            aps = (await self._get("/api/wifi_recon/aps")).get("aps", [])
        except Exception:  # noqa: BLE001
            aps = []
        tbl = self.query_one("#wr-aps", DataTable)
        tbl.clear()
        for a in aps[:50]:
            enc = f"{a.get('encryption') or '?'}"
            if a.get("wps"):
                enc = f"[yellow]{enc} WPS[/]"
            tbl.add_row(
                a.get("bssid", ""),
                (a.get("essid") or "—")[:24],
                str(a.get("channel") or ""),
                enc,
                str(a.get("signal") or ""),
                str(a.get("beacons") or ""),
                (a.get("first_seen") or "")[-8:],
            )

        try:
            clients = (await self._get("/api/wifi_recon/clients")).get("clients", [])
        except Exception:  # noqa: BLE001
            clients = []
        ctbl = self.query_one("#wr-clients", DataTable)
        ctbl.clear()
        for c in clients[:50]:
            ctbl.add_row(
                c.get("station", ""),
                c.get("associated") or "—",
                str(c.get("power") or ""),
                str(c.get("packets") or ""),
                ", ".join(c.get("probes") or [])[:32],
            )

        try:
            h = (await self._get("/api/wifi_recon/handshakes")).get("handshakes", [])
        except Exception:  # noqa: BLE001
            h = []
        htbl = self.query_one("#wr-hands", DataTable)
        htbl.clear()
        for row in h[:50]:
            mark = "[green]✓[/]" if row.get("eapol") else "[dim]·[/]"
            htbl.add_row(
                row.get("filename", ""),
                f"{(row.get('size_bytes') or 0) // 1024} KB",
                mark,
                (row.get("mtime") or "")[:19],
            )

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        note = self.query_one("#wr-note", Static)
        try:
            if ev.button.id == "btn-start":
                channels = self.query_one("#inp-channels", Input).value.strip() or "all"
                d = await self._post("/api/wifi_recon/start", {"channels": channels})
                note.update(f"[green]started[/]  {d.get('state', {}).get('prefix', '')}")
            elif ev.button.id == "btn-stop":
                d = await self._post("/api/wifi_recon/stop")
                note.update(f"[green]stopped[/]  helper={d.get('helper', '')}")
        except httpx.HTTPStatusError as e:
            note.update(f"[red]{e.response.status_code}: {e.response.text[:160]}[/]")
        except Exception as e:  # noqa: BLE001
            note.update(f"[red]error: {e}[/]")
        await self._refresh()
