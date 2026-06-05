"""Crack Queue TUI screen — Jobs / New / Files.

Mirrors the web Crack page against the SAME module APIs:
  GET  /api/crack/status      counts + hashcat presence + hashfiles + wordlists + jobs
  GET  /api/crack/jobs        full queue
  POST /api/crack/jobs        submit (hashfile + wordlist + mode + target)
  POST /api/crack/jobs/{id}/cancel

Cracking is engagement-gated server-side (the submit 403s when OFF / out of
scope); that refusal is surfaced verbatim — never faked.
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


class CrackScreen(Widget):
    DEFAULT_CSS = """
    CrackScreen { padding: 1 2; }
    #cr-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #cr-jobs { height: 18; }
    #cr-hashfiles, #cr-wordlists { height: 12; }
    #cr-new { height: auto; padding: 0 1; }
    #cr-new Input { margin: 0 0 1 0; }
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
        self._selected_job: str | None = None

    def compose(self) -> ComposeResult:
        yield Label("[b]Crack Queue[/]  —  hashcat WPA*/PMKID job queue")
        yield Grid(id="cr-tiles")
        with TabbedContent(initial="jobs"):
            with TabPane("Jobs", id="jobs"):
                with Horizontal():
                    yield Button("✖ Cancel selected", id="btn-cancel", classes="danger")
                    yield Static("  [dim]select a job row, then Cancel[/]", id="cr-jobs-note")
                yield DataTable(zebra_stripes=True, cursor_type="row", id="cr-jobs")
            with TabPane("New", id="new"):
                with Vertical(id="cr-new"):
                    yield Label("Hashfile (path — pick on Files tab or paste a .hc22000/.cap)")
                    yield Input(placeholder="…/captures/wifi/pmkid-….hc22000", id="inp-hashfile")
                    yield Label("Wordlist (filename under wordlists/ — blank = rockyou.txt)")
                    yield Input(placeholder="rockyou.txt", id="inp-wordlist")
                    yield Label("Mode")
                    with RadioSet(id="cr-mode"):
                        yield RadioButton("22000 (WPA* PBKDF2)", value=True, id="mode-22000")
                        yield RadioButton("16800 (legacy PMKID)", id="mode-16800")
                    yield Label("Target BSSID/ESSID (scope-checked)")
                    yield Input(placeholder="(optional)", id="inp-target")
                    yield Button("▶ SUBMIT CRACK JOB", id="btn-submit")
                    yield Static("", id="cr-new-note")
            with TabPane("Files", id="files"):
                yield Label("Hashfiles — select to use as the job hashfile")
                yield DataTable(zebra_stripes=True, cursor_type="row", id="cr-hashfiles")
                yield Label("Wordlists — select to use as the job wordlist")
                yield DataTable(zebra_stripes=True, cursor_type="row", id="cr-wordlists")

    async def on_mount(self) -> None:
        grid = self.query_one("#cr-tiles", Grid)
        for key, title in [
            ("gate", "Engagement"),
            ("hashcat", "hashcat"),
            ("active", "Active"),
            ("cracked", "Cracked"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        self.query_one("#cr-jobs", DataTable).add_columns(
            "id", "status", "prog", "hashfile", "wordlist", "mode", "recovered"
        )
        self.query_one("#cr-hashfiles", DataTable).add_columns("file", "size", "path")
        self.query_one("#cr-wordlists", DataTable).add_columns("file", "size")
        await self._refresh()
        self.set_interval(self.POLL, self._refresh)

    async def _get(self, path: str) -> Any:
        async with httpx.AsyncClient(auth=self.auth, timeout=3.0) as c:
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
            st = await self._get("/api/crack/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["gate"].update_values("err", str(e), severity="err")
            return
        on = bool(st.get("engaged"))
        eng = st.get("engagement") or {}
        self._tiles["gate"].update_values(
            "ENGAGED" if on else "SAFE", eng.get("name") or "", severity="err" if on else "warn"
        )
        hc = st.get("hashcat") or {}
        self._tiles["hashcat"].update_values(
            "present" if hc.get("present") else "missing", "", severity="ok" if hc.get("present") else "warn"
        )
        counts = st.get("counts") or {}
        self._tiles["active"].update_values(
            str((counts.get("running") or 0) + (counts.get("queued") or 0)),
            f"run {counts.get('running', 0)} / q {counts.get('queued', 0)}",
            severity="ok",
        )
        self._tiles["cracked"].update_values(
            str(counts.get("cracked") or 0), f"total {counts.get('total', 0)}",
            severity="ok" if counts.get("cracked") else "warn",
        )

        jt = self.query_one("#cr-jobs", DataTable)
        jt.clear()
        for j in st.get("jobs", [])[:50]:
            jid = j.get("id", "")
            prog = j.get("progress")
            prog_s = f"{prog:.0f}%" if isinstance(prog, (int, float)) else "—"
            jt.add_row(
                jid[:8],
                j.get("status") or "",
                prog_s,
                (j.get("hashfile_name") or "")[:18],
                (j.get("wordlist_name") or "")[:14],
                str(j.get("mode") or ""),
                (j.get("recovered") or j.get("cracked") or "")[:20] if isinstance(j.get("recovered") or j.get("cracked"), str) else "—",
                key=jid,
            )

        ht = self.query_one("#cr-hashfiles", DataTable)
        ht.clear()
        for h in st.get("hashfiles", [])[:50]:
            ht.add_row(h.get("filename", ""), f"{(h.get('size_bytes') or 0) // 1024} KB",
                       h.get("path", ""), key=h.get("path", ""))
        wt = self.query_one("#cr-wordlists", DataTable)
        wt.clear()
        for w in st.get("wordlists", [])[:50]:
            wt.add_row(w.get("filename", ""), f"{(w.get('size_bytes') or 0) // 1024} KB",
                       key=w.get("filename", ""))

    async def on_data_table_row_selected(self, ev: DataTable.RowSelected) -> None:
        tid = ev.data_table.id
        key = str(ev.row_key.value) if ev.row_key else ""
        if tid == "cr-jobs":
            self._selected_job = key
            self.query_one("#cr-jobs-note", Static).update(f"  selected job [cyan]{key[:8]}[/]")
        elif tid == "cr-hashfiles":
            self.query_one("#inp-hashfile", Input).value = key
            self.query_one("#cr-new-note", Static).update(f"[green]hashfile set[/] {key}")
        elif tid == "cr-wordlists":
            self.query_one("#inp-wordlist", Input).value = key
            self.query_one("#cr-new-note", Static).update(f"[green]wordlist set[/] {key}")

    def _mode(self) -> str:
        rs = self.query_one("#cr-mode", RadioSet)
        if rs.pressed_button is None:
            return "22000"
        return "16800" if (rs.pressed_button.id or "").endswith("16800") else "22000"

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        if ev.button.id == "btn-submit":
            note = self.query_one("#cr-new-note", Static)
            hashfile = self.query_one("#inp-hashfile", Input).value.strip()
            if not hashfile:
                note.update("[red]hashfile required — pick one on the Files tab[/]")
                return
            wordlist = self.query_one("#inp-wordlist", Input).value.strip() or None
            target = self.query_one("#inp-target", Input).value.strip() or None
            body = {"hashfile": hashfile, "mode": self._mode()}
            if wordlist:
                body["wordlist"] = wordlist
            if target:
                body["target"] = target
            note.update("[yellow]submitting…[/]")
            try:
                d = await self._post("/api/crack/jobs", body)
                note.update(f"[green]queued[/] job {(d.get('job_id') or '?')[:8]}")
            except httpx.HTTPStatusError as e:
                body_txt = (e.response.text or "")[:200]
                if e.response.status_code == 403:
                    note.update(f"[red]refused (403)[/] — {body_txt or 'engagement gate / out-of-scope'}")
                else:
                    note.update(f"[red]failed {e.response.status_code}: {body_txt}[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"[red]error: {e}[/]")
            await self._refresh()
        elif ev.button.id == "btn-cancel":
            note = self.query_one("#cr-jobs-note", Static)
            if not self._selected_job:
                note.update("  [red]select a job row first[/]")
                return
            try:
                await self._post(f"/api/crack/jobs/{self._selected_job}/cancel")
                note.update(f"  [yellow]cancel requested[/] {self._selected_job[:8]}")
            except httpx.HTTPStatusError as e:
                note.update(f"  [red]cancel failed {e.response.status_code}: {(e.response.text or '')[:120]}[/]")
            except Exception as e:  # noqa: BLE001
                note.update(f"  [red]cancel error: {e}[/]")
            await self._refresh()
