"""Mesh TUI screen — node list DataTable + live packet tail."""
from __future__ import annotations

import asyncio
import json

import httpx
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import DataTable, Input, Label, RichLog


class MeshScreen(Widget):
    DEFAULT_CSS = """
    MeshScreen { padding: 1 2; }
    #nodes-panel  { width: 70%; }
    #packets-panel { width: 30%; }
    DataTable  { height: 20; }
    RichLog    { height: 20; border: round $accent; }
    """

    POLL_SECONDS = 5.0

    def __init__(self, *, api_url: str = "http://127.0.0.1:7777", auth: tuple[str, str] | None = None) -> None:
        super().__init__()
        self.api_url = api_url.rstrip("/")
        self.auth = auth
        self._ws_task: asyncio.Task | None = None

    def compose(self) -> ComposeResult:
        yield Label("[b]Mesh[/]  —  Meshtastic node list + live packet tail")
        with Horizontal():
            with Vertical(id="nodes-panel"):
                yield DataTable(zebra_stripes=True, id="nodes")
                yield Input(placeholder="Channel 0 message  (Enter to send)", id="send-input")
            with Vertical(id="packets-panel"):
                yield Label("[dim]RX packets[/]")
                yield RichLog(id="packets", highlight=True, markup=True)

    async def on_mount(self) -> None:
        table = self.query_one("#nodes", DataTable)
        table.add_columns("id", "short", "long", "snr", "hops", "batt", "last_heard")
        await self._refresh_nodes()
        self.set_interval(self.POLL_SECONDS, self._refresh_nodes)
        self._ws_task = asyncio.create_task(self._tail_packets())

    async def on_unmount(self) -> None:
        if self._ws_task:
            self._ws_task.cancel()

    async def _refresh_nodes(self) -> None:
        table = self.query_one("#nodes", DataTable)
        try:
            async with httpx.AsyncClient(auth=self.auth, timeout=5.0) as c:
                r = await c.get(f"{self.api_url}/api/mesh/nodes")
                r.raise_for_status()
                nodes = r.json()
        except Exception as e:  # noqa: BLE001
            table.clear()
            table.add_row("error", str(e), "", "", "", "", "")
            return
        table.clear()
        for n in nodes[:100]:
            table.add_row(
                str(n.get("id", ""))[:12],
                str(n.get("short_name", "") or ""),
                str(n.get("long_name", "") or "")[:24],
                str(n.get("snr", "") or ""),
                str(n.get("hops_away", "") or ""),
                f"{n.get('battery_pct', '')}%" if n.get("battery_pct") is not None else "",
                str(n.get("last_heard", "") or ""),
            )

    async def _tail_packets(self) -> None:
        log = self.query_one("#packets", RichLog)
        ws_url = self.api_url.replace("http", "ws") + "/api/mesh/packets"
        try:
            # httpx doesn't do WS; use `websockets` library.
            import websockets

            async with websockets.connect(ws_url) as ws:
                while True:
                    msg = await ws.recv()
                    try:
                        obj = json.loads(msg)
                        pl = obj.get("payload", {})
                        log.write(
                            f"[cyan]{pl.get('from', '?')}[/] → [magenta]{pl.get('to', '?')}[/] "
                            f"snr={pl.get('rxSnr', '?')} rssi={pl.get('rxRssi', '?')} "
                            f"{pl.get('text') or pl.get('portnum') or ''}"
                        )
                    except Exception:  # noqa: BLE001
                        log.write(str(msg))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.write(f"[red]packet stream closed: {e}[/]")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if not text:
            return
        event.input.value = ""
        try:
            async with httpx.AsyncClient(auth=self.auth, timeout=5.0) as c:
                r = await c.post(
                    f"{self.api_url}/api/mesh/send",
                    json={"text": text, "channel": 0},
                )
                r.raise_for_status()
            self.app.notify(f"sent: {text}")
        except Exception as e:  # noqa: BLE001
            self.app.notify(f"send failed: {e}", severity="error")
