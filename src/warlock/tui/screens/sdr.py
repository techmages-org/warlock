"""SDR TUI screen — ADS-B / rtl_433 / Presets / Device."""
from __future__ import annotations

import json
from typing import Any

import httpx
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import (
    Button,
    DataTable,
    Label,
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)

from warlock.tui.widgets.tile import Tile


class SdrScreen(Widget):
    DEFAULT_CSS = """
    SdrScreen { padding: 1 2; }
    #sdr-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #adsb-tbl  { height: 20; }
    #rtl433-log { height: 20; }
    #presets-tbl { height: 14; }
    #device-log  { height: 16; }
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
        yield Label("[b]SDR[/]  —  RTL-SDR scanner / ADS-B / rtl_433")
        yield Grid(id="sdr-tiles")
        with TabbedContent(initial="adsb"):
            with TabPane("ADS-B", id="adsb"):
                with Horizontal():
                    yield Button("▶ START READSB", id="btn-adsb-start")
                    yield Button("■ STOP READSB", id="btn-adsb-stop")
                    yield Static("  ", id="adsb-note")
                yield DataTable(zebra_stripes=True, id="adsb-tbl")
            with TabPane("rtl_433", id="rtl433"):
                with Horizontal():
                    yield Button("▶ START", id="btn-433-start")
                    yield Button("■ STOP", id="btn-433-stop")
                    yield Static("  ", id="r433-note")
                yield RichLog(id="rtl433-log", highlight=True, markup=True)
            with TabPane("Presets", id="presets"):
                yield Static(
                    "[dim]preset scanner arrives in a future wave — listed read-only.[/]"
                )
                yield DataTable(zebra_stripes=True, id="presets-tbl")
            with TabPane("Device", id="device"):
                with Horizontal():
                    yield Button("claim readsb", id="btn-claim-adsb")
                    yield Button("claim rtl_433", id="btn-claim-433")
                    yield Button("release", id="btn-release")
                yield RichLog(id="device-log", highlight=True, markup=True, wrap=True)

    async def on_mount(self) -> None:
        grid = self.query_one("#sdr-tiles", Grid)
        for key, title in [
            ("dev", "Device"),
            ("tuner", "Tuner"),
            ("lock", "SDR Lock"),
            ("active", "Active"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        atbl = self.query_one("#adsb-tbl", DataTable)
        atbl.add_columns("ICAO", "callsign", "alt ft", "kt", "hdg", "seen")
        ptbl = self.query_one("#presets-tbl", DataTable)
        ptbl.add_columns("id", "label", "MHz", "mode", "BW kHz")
        try:
            presets = (await self._get("/api/sdr/presets")).get("presets", [])
            for p in presets:
                ptbl.add_row(
                    p.get("id", ""),
                    p.get("label", ""),
                    f"{p.get('freq_mhz')}",
                    p.get("mode", ""),
                    f"{p.get('bw_khz')}",
                )
        except Exception:  # noqa: BLE001
            pass
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=4.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict | None = None) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=10.0) as c:
            r = await c.post(f"{self.api_url}{path}", json=body or {})
            r.raise_for_status()
            return r.json()

    async def _refresh(self) -> None:
        try:
            st = await self._get("/api/sdr/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["dev"].update_values("err", str(e), severity="err")
            return
        detected = bool(st.get("rtl_sdr_detected"))
        self._tiles["dev"].update_values(
            "present" if detected else "missing",
            f"count {st.get('device_count', 0)}",
            severity="ok" if detected else "warn",
        )
        self._tiles["tuner"].update_values(st.get("tuner") or "—")
        holder = (st.get("lock") or {}).get("holder") or "—"
        self._tiles["lock"].update_values(holder, "", severity="warn" if holder != "—" else "ok")
        active_bits = []
        if (st.get("readsb") or {}).get("active"):
            active_bits.append("readsb")
        if (st.get("rtl_433") or {}).get("active"):
            active_bits.append("rtl_433")
        self._tiles["active"].update_values(
            ", ".join(active_bits) or "idle",
            "",
            severity="ok" if active_bits else "warn",
        )
        # Device log
        dlog = self.query_one("#device-log", RichLog)
        dlog.clear()
        dlog.write(f"[b]blacklist[/] present={st.get('blacklist', {}).get('present')}")
        dlog.write(f"[b]usb_present[/] {st.get('usb_present')}")
        dlog.write("")
        dlog.write((st.get("probe_raw") or "").strip() or "[dim](no rtl_test output)[/]")

        # ADS-B
        try:
            ad = await self._get("/api/sdr/adsb/aircraft")
            atbl = self.query_one("#adsb-tbl", DataTable)
            atbl.clear()
            note = self.query_one("#adsb-note", Static)
            if ad.get("ok"):
                note.update(f"[green]readsb active — {ad.get('count', 0)} aircraft[/]")
                for a in ad.get("aircraft", [])[:40]:
                    atbl.add_row(
                        a.get("icao", ""),
                        (a.get("callsign") or "—")[:8],
                        str(a.get("altitude_ft") or ""),
                        str(a.get("speed_kt") or ""),
                        str(a.get("heading") or ""),
                        f"{a.get('seen_s') or ''}s",
                    )
            else:
                note.update(f"[yellow]{ad.get('reason', 'readsb inactive')}[/]")
        except Exception as e:  # noqa: BLE001
            try:
                self.query_one("#adsb-note", Static).update(f"[red]{e}[/]")
            except Exception:  # noqa: BLE001
                pass

        # rtl_433 last events
        try:
            rv = await self._get("/api/sdr/rtl433/events?n=30")
            rlog = self.query_one("#rtl433-log", RichLog)
            rlog.clear()
            for ev in rv.get("events", [])[-30:]:
                rlog.write(
                    f"[dim]{ev.get('time', '')}[/]  "
                    f"[cyan]{ev.get('model', '?')}[/]  "
                    f"{json.dumps({k: v for k, v in ev.items() if k not in ('time', 'model')})}"
                )
            self.query_one("#r433-note", Static).update(
                f"[green]running[/]" if rv.get("running") else "[dim]stopped[/]"
            )
        except Exception:  # noqa: BLE001
            pass

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        note = self.query_one("#adsb-note", Static)
        r433note = self.query_one("#r433-note", Static)
        try:
            if ev.button.id == "btn-adsb-start":
                await self._post("/api/sdr/adsb/start")
                note.update("[green]readsb start requested[/]")
            elif ev.button.id == "btn-adsb-stop":
                await self._post("/api/sdr/adsb/stop")
                note.update("[yellow]readsb stop requested[/]")
            elif ev.button.id == "btn-433-start":
                await self._post("/api/sdr/rtl433/start")
                r433note.update("[green]rtl_433 started[/]")
            elif ev.button.id == "btn-433-stop":
                await self._post("/api/sdr/rtl433/stop")
                r433note.update("[yellow]rtl_433 stopped[/]")
            elif ev.button.id == "btn-claim-adsb":
                await self._post("/api/sdr/adsb/start")
            elif ev.button.id == "btn-claim-433":
                await self._post("/api/sdr/rtl433/start")
            elif ev.button.id == "btn-release":
                await self._post("/api/sdr/lock/release")
        except httpx.HTTPStatusError as e:
            msg = f"[red]{e.response.status_code}: {e.response.text[:160]}[/]"
            if ev.button.id.startswith("btn-433"):
                r433note.update(msg)
            else:
                note.update(msg)
        except Exception as e:  # noqa: BLE001
            note.update(f"[red]{e}[/]")
        await self._refresh()
