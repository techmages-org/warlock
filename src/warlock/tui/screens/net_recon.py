"""Net Recon TUI screen — Hosts / Scans / Builder / Audit."""
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
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)

from warlock.tui.widgets.tile import Tile


class NetReconScreen(Widget):
    DEFAULT_CSS = """
    NetReconScreen { padding: 1 2; }
    #nr-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #nr-hosts, #nr-scans { height: 22; }
    #nr-build { padding: 0 1; height: auto; }
    #nr-build Input { margin: 0 0 1 0; }
    #nr-audit-log { height: 22; }
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
        yield Label("[b]Net Recon[/]  —  arp/icmp sweep + nmap profiles")
        yield Grid(id="nr-tiles")
        with TabbedContent(initial="hosts"):
            with TabPane("Hosts", id="hosts"):
                yield DataTable(zebra_stripes=True, id="nr-hosts")
            with TabPane("Scans", id="scans"):
                yield DataTable(zebra_stripes=True, id="nr-scans")
            with TabPane("New", id="new"):
                with Vertical(id="nr-build"):
                    yield Label("Targets — comma-separated IP / CIDR")
                    yield Input(placeholder="192.168.100.1, 192.168.100.0/24", id="nr-targets")
                    yield Label("Profile")
                    with RadioSet(id="nr-profile"):
                        yield RadioButton("quick (top 100)", value=True, id="prof-quick")
                        yield RadioButton("top1000", id="prof-top1000")
                        yield RadioButton("full (-p-)", id="prof-full")
                        yield RadioButton("service (-sV -sC)", id="prof-service")
                        yield RadioButton("vuln scripts", id="prof-vuln")
                    with Horizontal():
                        yield Button("▶ ARP sweep (current LAN)", id="btn-arp")
                        yield Button("▶ Run port scan", id="btn-scan")
                    yield Static("", id="nr-note")
            with TabPane("Audit", id="audit"):
                yield RichLog(id="nr-audit-log", highlight=True, markup=True, wrap=True)

    async def on_mount(self) -> None:
        grid = self.query_one("#nr-tiles", Grid)
        for k, t in [("subnet", "Subnet"), ("hosts", "Hosts seen"), ("last", "Last scan"), ("gw", "Gateway")]:
            tile = Tile(t, "…")
            self._tiles[k] = tile
            grid.mount(tile)
        ht = self.query_one("#nr-hosts", DataTable)
        ht.add_columns("ip", "mac", "vendor", "hostname", "ports", "last")
        st = self.query_one("#nr-scans", DataTable)
        st.add_columns("when", "target", "profile", "status", "hosts")
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=4.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict | None = None) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=600.0) as c:
            r = await c.post(f"{self.api_url}{path}", json=body or {})
            r.raise_for_status()
            return r.json()

    async def _refresh(self) -> None:
        try:
            st = await self._get("/api/net_recon/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["subnet"].update_values("err", str(e), severity="err")
            return
        self._tiles["subnet"].update_values(st.get("subnet") or "—", "", severity="ok")
        self._tiles["hosts"].update_values(str(st.get("hosts_seen") or 0), "in DB", severity="ok")
        last = st.get("last_scan") or {}
        self._tiles["last"].update_values(last.get("status") or "—", last.get("profile", ""), severity="ok")
        self._tiles["gw"].update_values(st.get("gateway") or "—", "", severity="ok")

        # Hosts table
        try:
            d = await self._get("/api/net_recon/hosts?limit=200")
        except Exception:  # noqa: BLE001
            return
        ht = self.query_one("#nr-hosts", DataTable)
        ht.clear()
        for h in d.get("hosts", []):
            ports = ",".join(str(p["port"]) for p in (h.get("ports") or [])[:8])
            ht.add_row(h.get("ip", ""), h.get("mac", "") or "—",
                       (h.get("vendor", "") or "")[:24], h.get("hostname", "") or "—",
                       ports or "—", (h.get("last_seen") or "")[:19])

        # Scans table
        try:
            ds = await self._get("/api/net_recon/scans?limit=50")
        except Exception:  # noqa: BLE001
            return
        sct = self.query_one("#nr-scans", DataTable)
        sct.clear()
        for sc in ds.get("scans", []):
            sct.add_row((sc.get("started_at") or "")[:19], sc.get("target", "")[:32],
                        sc.get("profile", ""), sc.get("status", ""), str(sc.get("hosts_found", 0)))

    def _selected_profile(self) -> str:
        rs = self.query_one("#nr-profile", RadioSet)
        if rs.pressed_button is None:
            return "quick"
        bid = rs.pressed_button.id or ""
        return bid.replace("prof-", "") or "quick"

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        note = self.query_one("#nr-note", Static)
        if event.button.id == "btn-arp":
            note.update("[yellow]ARP sweep running…[/]")
            try:
                r = await self._post("/api/net_recon/arpscan")
                note.update(f"[green]ARP sweep ok — {len(r.get('hosts', []))} up[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"[red]ARP sweep failed: {e}[/]")
        elif event.button.id == "btn-scan":
            targets_in = self.query_one("#nr-targets", Input).value.strip()
            if not targets_in:
                note.update("[red]targets required[/]")
                return
            targets = [t.strip() for t in targets_in.split(",") if t.strip()]
            prof = self._selected_profile()
            note.update(f"[yellow]Scanning {len(targets)} target(s) profile={prof}…[/]")
            try:
                r = await self._post("/api/net_recon/portscan", {"targets": targets, "profile": prof})
                note.update(f"[green]Scan ok — {r.get('summary', {}).get('up', 0)} up[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"[red]Scan failed: {e}[/]")
