"""Warlock Textual TUI — tab-navigated module screens + kill switch."""
from __future__ import annotations

import argparse

import httpx
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Footer, Header, Label, Static


DEFAULT_API = "http://127.0.0.1:7777"


class KillswitchConfirm(ModalScreen[bool]):
    """Modal: 'KILL SWITCH — press Enter to confirm, Esc to cancel'."""

    BINDINGS = [
        Binding("enter", "confirm", "Confirm KILL SWITCH"),
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        yield Static(
            "[b red on yellow] ⚠  KILL SWITCH  ⚠ [/]\n\n"
            "Stops all active jobs, restores interfaces to managed mode.\n\n"
            "[b]Enter[/] to confirm • [b]Esc[/] to cancel",
            id="killswitch-body",
        )

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)


class WarlockApp(App):
    CSS = """
    Screen { background: $surface; }
    #banner-safe     { background: green;  color: white; padding: 0 1; }
    #banner-engaged  { background: red;    color: white; padding: 0 1; text-style: bold; }
    #banner-loading  { background: yellow; color: black; padding: 0 1; }
    #killswitch-body { width: 60; height: 10; align: center middle;
                       background: $panel; border: heavy red; padding: 1 2; content-align: center middle; }
    Tile { border: round $accent; padding: 0 1; margin: 0 1 1 0; min-width: 22; height: 6; }
    Tile.ok     { border: round green; }
    Tile.warn   { border: round yellow; }
    Tile.err    { border: round red; }
    """

    BINDINGS = [
        Binding("g,d", "goto('dashboard')", "Dashboard"),
        Binding("g,m", "goto('mesh')", "Mesh"),
        Binding("g,g", "goto('gps')", "GPS"),
        Binding("g,s", "goto('sdr')", "SDR"),
        Binding("g,w", "goto('wifi_recon')", "WiFi Recon"),
        Binding("g,o", "goto('wifi_offensive')", "Offensive"),
        Binding("g,n", "goto('net_recon')", "Net Recon"),
        Binding("g,e", "goto('ops')", "Engagements"),
        Binding("g,h", "goto('system')", "System"),
        Binding("ctrl+e", "toggle_engagement", "Toggle engagement"),
        Binding("ctrl+k", "killswitch", "KILL SWITCH"),
        Binding("question_mark", "help", "Keybindings"),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self, api_url: str = DEFAULT_API, basic_auth: tuple[str, str] | None = None) -> None:
        super().__init__()
        self.api_url = api_url.rstrip("/")
        self.basic_auth = basic_auth
        self._screens: dict[str, object] = {}

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        from warlock.tui.widgets.engagement_banner import EngagementBanner

        yield EngagementBanner(api_url=self.api_url, auth=self.basic_auth)
        self._body = Vertical(id="body")
        yield self._body
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_goto("dashboard")

    # ---- actions ----

    async def action_goto(self, module_id: str) -> None:
        scr = self._screens.get(module_id)
        if scr is None:
            scr = self._instantiate_screen(module_id)
            self._screens[module_id] = scr
        # Replace body children with the module screen's widget.
        await self._body.remove_children()
        await self._body.mount(scr)

    def _instantiate_screen(self, module_id: str):  # type: ignore[no-untyped-def]
        if module_id == "dashboard":
            from warlock.tui.screens.dashboard import DashboardScreen

            return DashboardScreen(api_url=self.api_url, auth=self.basic_auth)
        if module_id == "mesh":
            from warlock.tui.screens.mesh import MeshScreen

            return MeshScreen(api_url=self.api_url, auth=self.basic_auth)
        if module_id == "gps":
            from warlock.tui.screens.gps import GpsScreen

            return GpsScreen(api_url=self.api_url, auth=self.basic_auth)
        if module_id == "ops":
            from warlock.tui.screens.ops import OpsScreen

            return OpsScreen(api_url=self.api_url, auth=self.basic_auth)
        if module_id == "wifi_recon":
            from warlock.tui.screens.wifi_recon import WifiReconScreen

            return WifiReconScreen(api_url=self.api_url, auth=self.basic_auth)
        if module_id == "sdr":
            from warlock.tui.screens.sdr import SdrScreen

            return SdrScreen(api_url=self.api_url, auth=self.basic_auth)
        from warlock.tui.screens.stub import StubScreen

        labels = {
            "wifi_offensive": "Offensive WiFi",
            "net_recon": "Net Recon",
            "sdr_offensive": "Offensive SDR",
            "esp32_companion": "ESP32 Companion",
            "system": "System",
        }
        return StubScreen(module_id=module_id, label=labels.get(module_id, module_id.title()))

    async def action_toggle_engagement(self) -> None:
        # Minimal: call /api/engagements/active; full modal UI is on the ops screen.
        try:
            async with httpx.AsyncClient(auth=self.basic_auth, timeout=3.0) as c:
                r = await c.get(f"{self.api_url}/api/engagements/active")
                r.raise_for_status()
                status = r.json()
            self.notify(
                f"Engagement mode = {status.get('mode', '?')}. Create/activate from the Ops tab.",
                severity="warning" if status.get("mode") == "on" else "information",
            )
        except Exception as e:  # noqa: BLE001
            self.notify(f"engagement status failed: {e}", severity="error")

    async def action_killswitch(self) -> None:
        confirmed = await self.push_screen_wait(KillswitchConfirm())
        if not confirmed:
            self.notify("kill switch cancelled")
            return
        try:
            async with httpx.AsyncClient(auth=self.basic_auth, timeout=5.0) as c:
                r = await c.post(f"{self.api_url}/api/engagements/killswitch")
                r.raise_for_status()
                data = r.json()
            self.notify(
                f"KILL SWITCH fired: cancelled={data.get('cancelled_jobs')} restored={data.get('interfaces_restored')}",
                severity="warning",
            )
        except Exception as e:  # noqa: BLE001
            self.notify(f"killswitch failed: {e}", severity="error")

    def action_help(self) -> None:
        self.notify(
            "g+d dashboard • g+m mesh • g+g gps • g+s sdr • g+w wifi-recon • "
            "g+o offensive • g+n net-recon • g+e ops • g+h system • Ctrl+K kill • q quit",
        )


def main() -> None:
    parser = argparse.ArgumentParser("warlock-tui")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--user", default=None, help="Basic-auth username (if daemon requires it)")
    parser.add_argument("--password", default=None)
    args = parser.parse_args()
    auth = (args.user, args.password) if args.user and args.password else None
    WarlockApp(api_url=args.api, basic_auth=auth).run()


if __name__ == "__main__":
    main()
