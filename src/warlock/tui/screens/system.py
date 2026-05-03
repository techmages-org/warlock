"""System TUI screen — Hardware / Services / Network / Logs."""
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
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)

from warlock.tui.widgets.tile import Tile


class SystemScreen(Widget):
    DEFAULT_CSS = """
    SystemScreen { padding: 1 2; }
    #sys-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #sys-aio { grid-size: 5; grid-gutter: 1 1; height: auto; }
    #sys-svcs, #sys-ifs { height: 22; }
    #sys-log-ctrls Input { width: 24; margin-right: 1; }
    #sys-log { height: 22; }
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
        yield Label("[b]System[/]  —  hardware / services / journal")
        yield Grid(id="sys-tiles")
        with TabbedContent(initial="hw"):
            with TabPane("Hardware", id="hw"):
                yield Label("AIO V2 rails (GPIO 16/23/27)")
                yield Grid(id="sys-aio")
                with Horizontal():
                    yield Button("GPS ON", id="aio-gps-on")
                    yield Button("GPS OFF", id="aio-gps-off", classes="danger")
                    yield Button("LoRa ON", id="aio-lora-on")
                    yield Button("LoRa OFF", id="aio-lora-off", classes="danger")
                    yield Button("USB ON", id="aio-internal_usb-on")
                    yield Button("USB OFF", id="aio-internal_usb-off", classes="danger")
                yield Static("", id="sys-aio-note")
            with TabPane("Services", id="svc"):
                yield DataTable(zebra_stripes=True, id="sys-svcs")
                with Horizontal():
                    yield Input(placeholder="service name", id="sys-svc-name")
                    yield Button("start", id="svc-start")
                    yield Button("stop", id="svc-stop", classes="danger")
                    yield Button("restart", id="svc-restart")
                yield Static("", id="sys-svc-note")
            with TabPane("Network", id="net"):
                yield DataTable(zebra_stripes=True, id="sys-ifs")
                with Horizontal():
                    yield Button("Rescan WiFi APs", id="wifi-scan")
                yield Static("", id="sys-net-note")
            with TabPane("Logs", id="log"):
                with Horizontal(id="sys-log-ctrls"):
                    yield Input(placeholder="unit (eg warlock)", id="sys-log-unit")
                    yield Input(value="200", id="sys-log-lines")
                    yield Button("tail", id="btn-tail")
                yield RichLog(id="sys-log", highlight=True, markup=False, wrap=False)

    async def on_mount(self) -> None:
        g = self.query_one("#sys-tiles", Grid)
        for k, t in [("temp", "CPU temp"), ("mem", "Memory"), ("disk", "Disk free"), ("uptime", "Uptime")]:
            tile = Tile(t, "…")
            self._tiles[k] = tile
            g.mount(tile)
        st = self.query_one("#sys-svcs", DataTable)
        st.add_columns("unit", "active", "sub", "enabled", "main_pid")
        nt = self.query_one("#sys-ifs", DataTable)
        nt.add_columns("iface", "type", "up", "ipv4", "mac", "extra")
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=4.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict | None = None) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=20.0) as c:
            r = await c.post(f"{self.api_url}{path}", json=body or {})
            r.raise_for_status()
            return r.json()

    async def _refresh(self) -> None:
        try:
            st = await self._get("/api/system/status")
            self._tiles["temp"].update_values(f"{st.get('temp_c') or '?'} °C", st.get("throttled", "")[:24], severity="ok")
            self._tiles["mem"].update_values(f"{st.get('memory', {}).get('percent', '?')}%",
                                             f"{st.get('memory', {}).get('available_mb', 0):.0f} MB free", severity="ok")
            self._tiles["disk"].update_values(f"{st.get('disk_root', {}).get('free_mb', 0):.0f} MB",
                                              f"{st.get('disk_root', {}).get('percent', 0)}% used", severity="ok")
            self._tiles["uptime"].update_values(_fmt_dur(st.get("uptime_s", 0)), "", severity="ok")
        except Exception as e:  # noqa: BLE001
            self._tiles["temp"].update_values("err", str(e)[:32], severity="err")

        # AIO rails
        try:
            ar = await self._get("/api/system/aio")
            grid = self.query_one("#sys-aio", Grid)
            for child in list(grid.children):
                child.remove()
            for rail, info in (ar.get("rails") or {}).items():
                lvl = info.get("level", "?")
                t = Tile(info.get("label", rail), f"GPIO{info.get('gpio', '?')} = {lvl}")
                t.update_values(lvl.upper(), f"GPIO{info.get('gpio', '?')}",
                                severity="ok" if lvl == "hi" else "warn")
                await grid.mount(t)
        except Exception:  # noqa: BLE001
            pass

        # Services
        try:
            sv = await self._get("/api/system/services")
            tbl = self.query_one("#sys-svcs", DataTable)
            tbl.clear()
            for s in sv.get("services", []):
                tbl.add_row(s.get("unit", ""), str(s.get("active", False)),
                            s.get("substate", ""), str(s.get("enabled", False)),
                            s.get("mainpid", "0"))
        except Exception:  # noqa: BLE001
            pass

        # Interfaces
        try:
            nw = await self._get("/api/system/network")
            tbl = self.query_one("#sys-ifs", DataTable)
            tbl.clear()
            for i in nw.get("interfaces", []):
                extra = ""
                if i.get("ssid"):
                    extra = f"{i.get('ssid')} · {i.get('signal', '')}"
                tbl.add_row(i.get("name", ""), i.get("type", ""),
                            "▲" if i.get("up") else "▽",
                            ",".join(i.get("ipv4", [])) or "—",
                            i.get("mac", "") or "—",
                            extra)
        except Exception:  # noqa: BLE001
            pass

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id or ""
        if bid.startswith("aio-"):
            note = self.query_one("#sys-aio-note", Static)
            try:
                rail, action = bid[4:].rsplit("-", 1)  # eg "gps", "on"
                await self._post(f"/api/system/aio/{rail}/{action}")
                note.update(f"[green]{rail} → {action}[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"[red]{bid} failed: {e}[/]")
        elif bid in ("svc-start", "svc-stop", "svc-restart"):
            note = self.query_one("#sys-svc-note", Static)
            name = self.query_one("#sys-svc-name", Input).value.strip()
            if not name:
                note.update("[red]service name required[/]")
                return
            action = bid.split("-", 1)[1]
            try:
                await self._post(f"/api/system/services/{name}/{action}")
                note.update(f"[green]{name}: {action} ok[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"[red]{name} {action} failed: {e}[/]")
        elif bid == "wifi-scan":
            note = self.query_one("#sys-net-note", Static)
            try:
                d = await self._post("/api/system/wlan/scan")
                note.update(f"[green]found {d.get('count', 0)} APs[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"[red]scan failed: {e}[/]")
        elif bid == "btn-tail":
            unit = self.query_one("#sys-log-unit", Input).value.strip() or None
            try:
                lines = int(self.query_one("#sys-log-lines", Input).value or "200")
            except ValueError:
                lines = 200
            qs = f"lines={lines}"
            if unit:
                qs += f"&unit={unit}"
            try:
                d = await self._get(f"/api/system/journal?{qs}")
                log = self.query_one("#sys-log", RichLog)
                log.clear()
                for line in d.get("lines", []):
                    log.write(line)
            except Exception as e:  # noqa: BLE001
                self.query_one("#sys-log", RichLog).write(f"ERR: {e}")


def _fmt_dur(sec: int) -> str:
    sec = int(sec or 0)
    d, sec = divmod(sec, 86400)
    h, sec = divmod(sec, 3600)
    m, _ = divmod(sec, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"
