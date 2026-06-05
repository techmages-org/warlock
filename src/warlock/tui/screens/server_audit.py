"""Server Audit TUI screen — Run / Jobs / Findings.

Mirrors the web Audit page against the SAME module APIs:
  GET  /api/server_audit/status        audit types (+ remote flag) + counts + jobs
  POST /api/server_audit/run           {type, target, note, user, port, key, password}
  GET  /api/server_audit/jobs/{id}      full job + findings + tail

Per-type gating: the three REMOTE types (nmap-vuln / nikto / ssh-config) are
engagement-gated; LOCAL lynis is ungated. The contextual banner reflects that,
and a server 403 on a remote type with engagement OFF is surfaced verbatim.
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
    RichLog,
    Static,
    TabbedContent,
    TabPane,
)

from warlock.tui.widgets.tile import Tile

# id -> (label, remote?) — mirrors AUDIT_TYPES in the module.
_TYPES = [
    ("nmap-vuln", "nmap vuln scan", True),
    ("nikto", "nikto web scan", True),
    ("lynis", "lynis host hardening", False),
    ("ssh-config", "ssh remote config audit", True),
]
_SEV_COLOR = {"critical": "red", "high": "red", "medium": "yellow", "low": "cyan", "info": "dim"}


class ServerAuditScreen(Widget):
    DEFAULT_CSS = """
    ServerAuditScreen { padding: 1 2; }
    #sa-gate          { padding: 0 1; margin: 0 0 1 0; }
    #sa-gate.engaged  { background: red;   color: white; text-style: bold; }
    #sa-gate.safe     { background: green; color: white; }
    #sa-gate.loading  { background: yellow; color: black; }
    #sa-tiles { grid-size: 4; grid-gutter: 1 1; height: auto; }
    #sa-jobs  { height: 16; }
    #sa-findings { height: 22; }
    #sa-run { height: auto; padding: 0 1; }
    #sa-run Input { margin: 0 0 1 0; }
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
        self._engaged = False

    def compose(self) -> ComposeResult:
        yield Label("[b]Server Audit[/]  —  nmap-vuln / nikto / lynis / ssh-config")
        yield Static("[b black on yellow] … loading engagement status [/]", id="sa-gate")
        yield Grid(id="sa-tiles")
        with TabbedContent(initial="run"):
            with TabPane("Run", id="run"):
                with Vertical(id="sa-run"):
                    yield Label("Audit type")
                    with RadioSet(id="sa-type"):
                        for i, (tid, label, remote) in enumerate(_TYPES):
                            yield RadioButton(
                                f"{label}  [{'remote/gated' if remote else 'local'}]",
                                value=(i == 0), id=f"type-{tid}",
                            )
                    yield Label("Target — IP/host (nmap/ssh) or URL (nikto); ignored for lynis")
                    yield Input(placeholder="192.168.100.10 or https://host", id="inp-target")
                    yield Label("SSH only — user / port / key path / password")
                    with Horizontal():
                        yield Input(placeholder="user", id="inp-user")
                        yield Input(value="22", id="inp-port")
                    yield Input(placeholder="~/.ssh/id_ed25519 (key path)", id="inp-key")
                    yield Input(placeholder="password (needs sshpass)", password=True, id="inp-pass")
                    yield Button("▶ RUN AUDIT", id="btn-run")
                    yield Static("", id="sa-run-note")
            with TabPane("Jobs", id="jobs"):
                yield Static("[dim]select a job row to load its findings[/]", id="sa-jobs-note")
                yield DataTable(zebra_stripes=True, cursor_type="row", id="sa-jobs")
            with TabPane("Findings", id="findings"):
                yield RichLog(id="sa-findings", highlight=True, markup=True, wrap=True)

    async def on_mount(self) -> None:
        grid = self.query_one("#sa-tiles", Grid)
        for key, title in [
            ("gate", "Engagement"),
            ("running", "Running"),
            ("done", "Done"),
            ("worst", "Worst"),
        ]:
            t = Tile(title, "…")
            self._tiles[key] = t
            grid.mount(t)
        self.query_one("#sa-jobs", DataTable).add_columns(
            "id", "type", "status", "target", "findings", "max"
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

    def _set_gate(self, mode: str, name: str = "") -> None:
        gate = self.query_one("#sa-gate", Static)
        for cls in ("engaged", "safe", "loading"):
            gate.remove_class(cls)
        if mode == "on":
            self._engaged = True
            gate.add_class("engaged")
            gate.update(f" ⚠  ENGAGED — {name or 'active'}  •  remote audits run in-scope; lynis is local/ungated")
            self._tiles["gate"].update_values("ENGAGED", name or "", severity="err")
        elif mode == "off":
            self._engaged = False
            gate.add_class("safe")
            gate.update(" ✓  SAFE — remote audits (nmap/nikto/ssh) refused (403); lynis (local) still runs")
            self._tiles["gate"].update_values("SAFE", "remote gated", severity="warn")
        else:
            self._engaged = False
            gate.add_class("loading")
            gate.update(" … loading engagement status ")
            self._tiles["gate"].update_values("…", "")

    async def _refresh(self) -> None:
        try:
            st = await self._get("/api/server_audit/status")
        except Exception as e:  # noqa: BLE001
            self._tiles["gate"].update_values("err", str(e), severity="err")
            self._set_gate("loading")
            return
        eng = st.get("engagement") or {}
        self._set_gate("on" if st.get("engaged") else "off", eng.get("name") or "")
        counts = st.get("counts") or {}
        self._tiles["running"].update_values(
            str((counts.get("running") or 0) + (counts.get("queued") or 0)), "queued+running"
        )
        self._tiles["done"].update_values(str(counts.get("done") or counts.get("finished") or counts.get("total") or 0), "total")

        jt = self.query_one("#sa-jobs", DataTable)
        jt.clear()
        worst = "—"
        for j in st.get("jobs", [])[:50]:
            summ = j.get("summary") or {}
            mx = summ.get("max") or "—"
            if mx and mx != "—":
                worst = mx
            jt.add_row(
                (j.get("id") or "")[:8],
                j.get("audit_type") or j.get("type") or "",
                j.get("status") or "",
                (j.get("target") or "")[:22],
                str(summ.get("total") or 0),
                mx or "—",
                key=j.get("id", ""),
            )
        self._tiles["worst"].update_values(
            worst, "", severity="err" if worst in ("critical", "high") else "warn" if worst != "—" else "ok"
        )

    async def on_data_table_row_selected(self, ev: DataTable.RowSelected) -> None:
        if ev.data_table.id != "sa-jobs":
            return
        jid = str(ev.row_key.value) if ev.row_key else ""
        if not jid:
            return
        log = self.query_one("#sa-findings", RichLog)
        log.clear()
        try:
            d = await self._get(f"/api/server_audit/jobs/{jid}")
        except Exception as e:  # noqa: BLE001
            log.write(f"[red]could not load job {jid[:8]}: {e}[/]")
            return
        job = d.get("job") or {}
        log.write(f"[b]{job.get('audit_type', '')}[/]  target=[cyan]{job.get('target') or '—'}[/]  "
                  f"status={job.get('status', '')}  rc={job.get('returncode')}")
        if job.get("error"):
            log.write(f"[red]error: {job['error']}[/]")
        findings = job.get("findings") or []
        if not findings:
            log.write("[dim](no findings)[/]")
        for f in findings:
            sev = f.get("severity") or "info"
            col = _SEV_COLOR.get(sev, "dim")
            log.write(f"[{col}]{sev.upper():8}[/] [b]{f.get('title', '')}[/]  [dim]{(f.get('detail') or '')[:160]}[/]")
        self.query_one("#sa-jobs-note", Static).update(f"loaded findings for [cyan]{jid[:8]}[/] — see Findings tab")

    def _selected_type(self) -> tuple[str, bool]:
        rs = self.query_one("#sa-type", RadioSet)
        bid = (rs.pressed_button.id or "type-nmap-vuln") if rs.pressed_button else "type-nmap-vuln"
        tid = bid.replace("type-", "")
        remote = next((r for t, _, r in _TYPES if t == tid), True)
        return tid, remote

    async def on_button_pressed(self, ev: Button.Pressed) -> None:
        if ev.button.id != "btn-run":
            return
        note = self.query_one("#sa-run-note", Static)
        tid, remote = self._selected_type()
        target = self.query_one("#inp-target", Input).value.strip()
        if tid != "lynis" and not target:
            note.update("[red]target required for this audit type[/]")
            return
        body: dict[str, Any] = {"type": tid}
        if target:
            body["target"] = target
        if tid == "ssh-config":
            user = self.query_one("#inp-user", Input).value.strip()
            if not user:
                note.update("[red]ssh-config requires a user[/]")
                return
            body["user"] = user
            try:
                body["port"] = int(self.query_one("#inp-port", Input).value.strip() or "22")
            except ValueError:
                body["port"] = 22
            key = self.query_one("#inp-key", Input).value.strip()
            pw = self.query_one("#inp-pass", Input).value.strip()
            if key:
                body["key"] = key
            if pw:
                body["password"] = pw
        note.update("[yellow]running…[/]")
        try:
            d = await self._post("/api/server_audit/run", body)
            note.update(f"[green]submitted[/] {tid} — job {(d.get('job_id') or '?')[:8]} (see Jobs)")
        except httpx.HTTPStatusError as e:
            body_txt = (e.response.text or "")[:200]
            if e.response.status_code == 403:
                note.update(f"[red]{tid} refused (403)[/] — {body_txt or 'remote audit needs an active in-scope engagement'}")
            else:
                note.update(f"[red]{tid} failed {e.response.status_code}: {body_txt}[/]")
        except Exception as e:  # noqa: BLE001
            note.update(f"[red]error: {e}[/]")
        await self._refresh()
