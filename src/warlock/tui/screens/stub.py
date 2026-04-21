"""Reusable 'module pending' placeholder screen."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widget import Widget
from textual.widgets import Label, Static


class StubScreen(Widget):
    """Rendered inside the app body. Not a Textual Screen (pushed screens collide
    with our tab swapping in app.py)."""

    DEFAULT_CSS = """
    StubScreen { padding: 1 2; }
    #stub-title { color: $accent; text-style: bold; }
    #stub-hint  { color: $text-muted; }
    """

    def __init__(self, *, module_id: str, label: str) -> None:
        super().__init__()
        self.module_id = module_id
        self.module_label = label

    def compose(self) -> ComposeResult:
        yield Label(f"⟦ {self.module_label} ⟧", id="stub-title")
        yield Static("")
        yield Static("Implementation pending — see roadmap in 02-warlock-command-center.md", id="stub-hint")
        yield Static("")
        yield Static(f"[b]Module id:[/] {self.module_id}")
        yield Static("")
        yield Static(
            "[b]Next steps[/]\n"
            "  • Flesh out the FastAPI router in src/warlock/modules/"
            f"{self.module_id}.py\n"
            "  • Implement a proper Textual screen under src/warlock/tui/screens/\n"
            "  • Wire the corresponding React page under web/src/pages/\n"
            "  • If this module is engagement-gated, use jobs.runner.submit(... requires_engagement=True)\n"
        )
