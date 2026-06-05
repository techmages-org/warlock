"""Offensive WiFi TUI screen — Target / Ops / Jobs / Loot.

Mirrors the web "Wireless" ACT flow against the SAME module APIs:
  - target list comes from ``/api/wifi_recon/aps`` (wifi_offensive has no AP
    endpoint of its own); a row-select fills the BSSID/channel, or type them in.
  - every op POSTs ``/api/wifi_offensive/{deauth,handshake,pmkid,evil_twin,
    karma,wps}`` — all engagement-gated SERVER-SIDE.

Gate discipline: this screen NEVER fakes a launch. A contextual gate banner
(driven off the module ``/status`` ``engaged`` flag) warns when engagement is
OFF, the op buttons are disabled, and any real server refusal is surfaced
verbatim from the ``403`` (status + body) — exactly the "don't pretend to fire"
contract. The global EngagementBanner stays at the app level too.
"""
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
    RadioButton,
    RadioSet,
    Static,
    TabbedContent,
    TabPane,
)

from warlock.tui.widgets.tile import Tile


class WifiOffensiveScreen(Widget):
    DEFAULT_CSS = """
    WifiOffensiveScreen { padding: 1 2; }
    #wo-gate          { padding: 0 1; margin: 0 0 1 0; }
    #wo-gate.engaged  { background: red;   color: white; text-style: bold; }
    #wo-gate.safe     { background: green; color: white; }
    #wo-gate.loading  { background: yellow; color: black; }
    #wo-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #wo-aps, #wo-jobs, #wo-loot { height: 18; }
    #wo-act, #wo-params { height: auto; padding: 0 1; }
    #wo-params Input { margin: 0 0 1 0; }
    .opbtn { margin: 0 1 1 0; }
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
        self._aps: dict[str, dict[str, Any]] = {}  # bssid -> ap row
        self._engaged: bool = False

    def compose(self) -> ComposeResult:
        yield Label("[b]Offensive WiFi[/]  —  active attacks vs IN-SCOPE targets (engagement-gated)")
        yield Static("[b black on yellow] … loading engagement status [/]", id="wo-gate")
        yield Grid(id="wo-tiles")
        with TabbedContent(initial="target"):
            with TabPane("Target", id="target"):
                yield Label("APs from wifi_recon — select a row to lock target, or type below")
                yield DataTable(zebra_stripes=True, cursor_type="row", id="wo-aps")
                with Vertical(id="wo-params"):
                    with Horizontal():
                        yield Label("BSSID ")
                        yield Input(placeholder="aa:bb:cc:dd:ee:ff", id="inp-bssid")
                        yield Label(" channel ")
                        yield Input(value="1", id="inp-channel")
                    with Horizontal():
                        yield Label("SSID (evil-twin) ")
                        yield Input(placeholder="(auto from selected AP)", id="inp-ssid")
                    yield Static("", id="wo-target-note")
            with TabPane("Ops", id="ops"):
                with Vertical(id="wo-act"):
                    yield Static("", id="wo-selected")
                    with Horizontal():
                        yield Label("deauth count ")
                        yield Input(value="64", id="inp-count")
                        yield Label(" duration s ")
                        yield Input(value="60", id="inp-duration")
                    with Horizontal():
                        yield Label("WPS tool ")
                        with RadioSet(id="wo-wps-tool"):
                            yield RadioButton("reaver", value=True, id="wps-reaver")
                            yield RadioButton("bully", id="wps-bully")
                    with Horizontal():
                        yield Button("⚡ Deauth", id="op-deauth", classes="opbtn danger")
                        yield Button("🤝 Handshake", id="op-handshake", classes="opbtn")
                        yield Button("🔑 PMKID", id="op-pmkid", classes="opbtn")
                    with Horizontal():
                        yield Button("👯 Evil-Twin", id="op-evil_twin", classes="opbtn")
                        yield Button("📡 Karma/MANA", id="op-karma", classes="opbtn")
                        yield Button("📌 WPS PIN", id="op-wps", classes="opbtn")
                    yield Static("", id="wo-op-note")
            with TabPane("Jobs", id="jobs"):
                yield DataTable(zebra_stripes=True, id="wo-jobs")
            with TabPane("Loot", id="loot"):
                yield Label("captures (.hc22000 / .pcapng / .cap) + wordlists")
                yield DataTable(zebra_stripes=True, id="wo-loot")

    async def on_mount(self) -> None:
        grid = self.query_one("#wo-tiles", Grid)
        for key, title in [
            ("gate", "Gate"),
            ("target", "Target"),
            ("iface", "Iface"),
            ("captures", "Captures"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        self.query_one("#wo-aps", DataTable).add_columns("BSSID", "ESSID", "CH", "ENC", "SIG")
        self.query_one("#wo-jobs", DataTable).add_columns("type", "status", "started", "target")
        self.query_one("#wo-loot", DataTable).add_columns("file", "kind", "size", "mtime")
        self._update_selected()
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

    def _set_gate(self, mode: str, name: str = "") -> None:
        gate = self.query_one("#wo-gate", Static)
        for cls in ("engaged", "safe", "loading"):
            gate.remove_class(cls)
        if mode == "on":
            self._engaged = True
            gate.add_class("engaged")
            gate.update(
                f" ⚠  ENGAGED — {name or 'active'}  •  in-scope ops will fire; "
                "out-of-scope targets still refused (403)"
            )
            self._tiles["gate"].update_values("ENGAGED", name or "", severity="err")
        elif mode == "off":
            self._engaged = False
            gate.add_class("safe")
            gate.update(
                " ✓  SAFE — engagement OFF  •  offensive ops are refused (403). "
                "Activate an engagement on the Ops tab first."
            )
            self._tiles["gate"].update_values("SAFE", "ops gated", severity="warn")
        else:
            self._engaged = False
            gate.add_class("loading")
            gate.update(" … loading engagement status ")
            self._tiles["gate"].update_values("…", "", severity="warn")
        self._sync_op_buttons()

    def _sync_op_buttons(self) -> None:
        # Mirror the web: ops disabled when engagement is OFF so we never just
        # silently 403. (An ON-but-out-of-scope target still 403s server-side.)
        for op in ("deauth", "handshake", "pmkid", "evil_twin", "karma", "wps"):
            try:
                self.query_one(f"#op-{op}", Button).disabled = not self._engaged
            except Exception:  # noqa: BLE001
                pass

    def _update_selected(self) -> None:
        try:
            sel = self.query_one("#wo-selected", Static)
        except Exception:  # noqa: BLE001
            return
        bssid = self.query_one("#inp-bssid", Input).value.strip()
        ch = self.query_one("#inp-channel", Input).value.strip()
        ssid = self.query_one("#inp-ssid", Input).value.strip()
        if bssid:
            sel.update(f"[b]Target[/] [cyan]{bssid}[/] ch={ch or '?'} ssid=[violet]{ssid or '—'}[/]")
            self._tiles["target"].update_values(bssid, f"ch {ch or '?'}", severity="ok")
        else:
            sel.update("[dim]no target — select an AP on the Target tab or type a BSSID[/]")
            self._tiles["target"].update_values("—", "")

    async def _refresh(self) -> None:
        # status + gate
        try:
            st = await self._get("/api/wifi_offensive/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["gate"].update_values("err", str(e), severity="err")
            self._set_gate("loading")
            return
        eng = st.get("engagement") or {}
        self._set_gate("on" if st.get("engaged") else "off", eng.get("name") or "")
        iface = st.get("iface") or {}
        self._tiles["iface"].update_values(iface.get("managed") or "—", iface.get("monitor") or "")
        caps = st.get("captures") or []
        self._tiles["captures"].update_values(str(len(caps)), "files", severity="ok" if caps else "warn")

        # jobs
        jt = self.query_one("#wo-jobs", DataTable)
        jt.clear()
        for j in st.get("recent_jobs", [])[:50]:
            jt.add_row(
                (j.get("type") or "")[:18],
                j.get("status") or "",
                (j.get("started_at") or "")[:19],
                (j.get("engagement_id") or "")[:8] or "—",
            )

        # loot (captures + wordlists)
        lt = self.query_one("#wo-loot", DataTable)
        lt.clear()
        for cap in caps[:50]:
            lt.add_row(
                cap.get("filename", ""),
                cap.get("kind", ""),
                f"{(cap.get('size_bytes') or 0) // 1024} KB",
                (cap.get("mtime") or "")[:19],
            )
        for wl in (st.get("wordlists") or [])[:20]:
            lt.add_row(wl.get("filename", ""), "wordlist", f"{(wl.get('size_bytes') or 0) // 1024} KB", "")

        # APs from wifi_recon (target source — mirrors the web)
        try:
            aps = (await self._get("/api/wifi_recon/aps")).get("aps", [])
        except Exception:  # noqa: BLE001
            aps = []
        tbl = self.query_one("#wo-aps", DataTable)
        tbl.clear()
        self._aps.clear()
        for a in aps[:80]:
            bssid = a.get("bssid", "")
            if not bssid:
                continue
            self._aps[bssid] = a
            enc = a.get("encryption") or "?"
            if a.get("wps"):
                enc = f"{enc} WPS"
            tbl.add_row(bssid, (a.get("essid") or "—")[:22], str(a.get("channel") or ""),
                        enc, str(a.get("signal") or ""), key=bssid)

    async def on_data_table_row_selected(self, ev: DataTable.RowSelected) -> None:
        if ev.data_table.id != "wo-aps":
            return
        bssid = str(ev.row_key.value) if ev.row_key else ""
        ap = self._aps.get(bssid)
        if not ap:
            return
        self.query_one("#inp-bssid", Input).value = bssid
        self.query_one("#inp-channel", Input).value = str(ap.get("channel") or "1")
        self.query_one("#inp-ssid", Input).value = ap.get("essid") or ""
        self.query_one("#wo-target-note", Static).update(
            f"[green]target locked[/] {ap.get('essid') or bssid} (ch {ap.get('channel') or '?'})"
        )
        self._update_selected()

    def _int(self, widget_id: str, default: int) -> int:
        try:
            return int(self.query_one(widget_id, Input).value.strip() or default)
        except ValueError:
            return default

    def _wps_tool(self) -> str:
        rs = self.query_one("#wo-wps-tool", RadioSet)
        if rs.pressed_button is None:
            return "reaver"
        return "bully" if (rs.pressed_button.id or "").endswith("bully") else "reaver"

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        bid = ev.button.id or ""
        if not bid.startswith("op-"):
            return
        op = bid[len("op-"):]
        note = self.query_one("#wo-op-note", Static)
        bssid = self.query_one("#inp-bssid", Input).value.strip()
        ssid = self.query_one("#inp-ssid", Input).value.strip()
        channel = self._int("#inp-channel", 1)
        duration = self._int("#inp-duration", 60)
        count = self._int("#inp-count", 64)

        # karma has no target; everything else needs a BSSID (evil_twin needs SSID).
        if op in ("deauth", "handshake", "pmkid", "wps") and not bssid:
            note.update("[red]BSSID required — select an AP on the Target tab[/]")
            return
        if op == "evil_twin" and not ssid:
            note.update("[red]SSID required for evil-twin (target a named AP)[/]")
            return

        path = f"/api/wifi_offensive/{op}"
        bodies: dict[str, dict[str, Any]] = {
            "deauth": {"bssid": bssid, "count": count},
            "handshake": {"bssid": bssid, "channel": channel, "duration": max(10, duration)},
            "pmkid": {"bssid": bssid, "duration": max(5, duration)},
            "evil_twin": {"ssid": ssid, "channel": channel},
            "karma": {"channel": channel},
            "wps": {"bssid": bssid, "channel": channel, "tool": self._wps_tool()},
        }
        note.update(f"[yellow]firing {op}…[/]")
        try:
            d = await self._post(path, bodies[op])
            jid = (d.get("job_id") or "")[:8]
            note.update(f"[green]{op} launched[/] — job {jid or '?'} target={d.get('target') or '—'}")
        except httpx.HTTPStatusError as e:
            # Surface the REAL server refusal verbatim — never fake success.
            body = (e.response.text or "")[:200]
            if e.response.status_code == 403:
                note.update(f"[red]{op} refused (403)[/] — {body or 'engagement gate / out-of-scope'}")
            else:
                note.update(f"[red]{op} failed {e.response.status_code}: {body}[/]")
        except Exception as e:  # noqa: BLE001
            note.update(f"[red]{op} error: {e}[/]")
        await self._refresh()
