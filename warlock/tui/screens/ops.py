"""Ops TUI screen — engagement lifecycle (Active / New / History / Audit)."""
from __future__ import annotations

from typing import Any

import httpx
from textual.app import ComposeResult
from textual.containers import Grid, Horizontal, Vertical, VerticalScroll
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
    TextArea,
)

from warlock.tui.widgets.tile import Tile


class OpsScreen(Widget):
    DEFAULT_CSS = """
    OpsScreen { padding: 1 2; }
    #active-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #active-ctrls { height: 3; padding: 0 0; }
    #new-form { padding: 1 2; height: auto; }
    #new-form Input { margin: 0 0 1 0; }
    #new-form TextArea { height: 6; margin: 0 0 1 0; }
    #hist-table { height: 16; }
    #audit-log  { height: 22; }
    Button.danger { background: $error; color: $text; }
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
        yield Label("[b]Operations[/]  —  engagement lifecycle + audit")
        with TabbedContent(initial="active"):
            with TabPane("Active", id="active"):
                yield Grid(id="active-tiles")
                with Horizontal(id="active-ctrls"):
                    yield Button("■ END ENGAGEMENT", id="btn-end")
                    yield Button("⚠ KILL SWITCH", id="btn-kill", classes="danger")
                    yield Static("", id="active-note")
            with TabPane("New", id="new"):
                with Vertical(id="new-form"):
                    yield Label("Name")
                    yield Input(placeholder="e.g. Q2 internal pentest", id="inp-name")
                    yield Label("Authorization statement (paste scope letter / lab note)")
                    yield TextArea(id="inp-auth")
                    yield Label("Targets — one per line (SSID, BSSID, or IP/CIDR)")
                    yield TextArea(id="inp-targets")
                    yield Label("Duration (hours)")
                    yield Input(value="4", id="inp-duration")
                    yield Button("▶ ACTIVATE ENGAGEMENT", id="btn-activate")
                    yield Static("", id="new-note")
            with TabPane("History", id="history"):
                yield DataTable(zebra_stripes=True, id="hist-table")
            with TabPane("Audit", id="audit"):
                yield RichLog(id="audit-log", highlight=True, markup=True, wrap=True)

    async def on_mount(self) -> None:
        grid = self.query_one("#active-tiles", Grid)
        for key, title in [
            ("mode", "Mode"),
            ("name", "Engagement"),
            ("elapsed", "Elapsed"),
            ("scope", "Scope"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        tbl = self.query_one("#hist-table", DataTable)
        tbl.add_columns("name", "status", "started", "ended", "targets")
        await self._refresh_all()
        self.set_interval(self.POLL, self._refresh_all)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
            r = await c.get(f"{self.api_url}{path}")
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict | None = None) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=5.0) as c:
            r = await c.post(f"{self.api_url}{path}", json=body or {})
            r.raise_for_status()
            return r.json()

    async def _refresh_all(self) -> None:
        try:
            st = await self._get("/api/ops/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["mode"].update_values("err", str(e), severity="err")
            return
        mode = st.get("mode", "off")
        on = mode == "on"
        self._tiles["mode"].update_values(
            "ENGAGED" if on else "SAFE",
            st.get("engagement_id") or "",
            severity="err" if on else "ok",
        )
        self._tiles["name"].update_values(
            st.get("name") or "—", st.get("started_at") or "", severity="warn" if on else "ok"
        )
        elapsed = st.get("elapsed_s")
        if elapsed is not None:
            h, rem = divmod(int(elapsed), 3600)
            m, s = divmod(rem, 60)
            self._tiles["elapsed"].update_values(f"{h:02d}:{m:02d}:{s:02d}", "", severity="ok")
        else:
            self._tiles["elapsed"].update_values("—", "")
        scope = st.get("scope") or {}
        parts = [
            f"{len(scope.get('ssids', []))} ssid",
            f"{len(scope.get('bssids', []))} bssid",
            f"{len(scope.get('ip_ranges', []))} ip",
        ]
        self._tiles["scope"].update_values(" · ".join(parts), "", severity="ok" if on else "warn")

        try:
            hist = await self._get("/api/ops/engagements?limit=30")
            tbl = self.query_one("#hist-table", DataTable)
            tbl.clear()
            for e in hist.get("engagements", []):
                tbl.add_row(
                    (e.get("name") or "")[:32],
                    e.get("status") or "",
                    (e.get("started_at") or "")[:19],
                    (e.get("ended_at") or "")[:19],
                    str(e.get("targets_count", 0)),
                )
        except Exception:  # noqa: BLE001
            pass

        try:
            audit = await self._get("/api/ops/audit?limit=100")
            log = self.query_one("#audit-log", RichLog)
            # Re-render last entries only (cheap; keeps pane tidy).
            log.clear()
            for a in reversed(audit.get("audit", [])):
                kind = a.get("kind", "")
                sev = "[red]" if "violation" in kind or "refused" == a.get("outcome") else "[green]"
                log.write(
                    f"{sev}{a.get('ts','')[:19]}[/]  [b]{kind}[/]  "
                    f"target=[cyan]{a.get('target') or '—'}[/]  "
                    f"outcome={a.get('outcome', '')}  {a.get('note','')}"
                )
        except Exception:  # noqa: BLE001
            pass

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        note = self.query_one("#active-note", Static)
        new_note = self.query_one("#new-note", Static)
        try:
            if ev.button.id == "btn-end":
                await self._post("/api/ops/engagements/end")
                note.update("[green]engagement ended[/]")
            elif ev.button.id == "btn-kill":
                d = await self._post("/api/ops/killswitch")
                note.update(
                    f"[red]KILL: cancelled={d.get('cancelled_jobs')} "
                    f"restored={d.get('interfaces_restored')}[/]"
                )
            elif ev.button.id == "btn-activate":
                name = self.query_one("#inp-name", Input).value.strip()
                auth = self.query_one("#inp-auth", TextArea).text.strip()
                targets = [
                    ln.strip()
                    for ln in self.query_one("#inp-targets", TextArea).text.splitlines()
                    if ln.strip()
                ]
                try:
                    dur = float(self.query_one("#inp-duration", Input).value or "4")
                except ValueError:
                    dur = 4.0
                body = {
                    "name": name,
                    "authorization": auth,
                    "targets": targets,
                    "duration_hours": dur,
                }
                await self._post("/api/ops/engagements", body=body)
                new_note.update("[green]engagement activated — see Active tab[/]")
        except httpx.HTTPStatusError as e:
            (new_note if ev.button.id == "btn-activate" else note).update(
                f"[red]error: {e.response.status_code} {e.response.text}[/]"
            )
        except Exception as e:  # noqa: BLE001
            (new_note if ev.button.id == "btn-activate" else note).update(f"[red]error: {e}[/]")
        await self._refresh_all()
