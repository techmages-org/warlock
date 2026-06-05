"""Module registry — auto-wires each warlock.modules.* into FastAPI + TUI."""
from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

from warlock.modules._base import ModuleBase

if TYPE_CHECKING:
    pass

# Canonical tab order. Editing this list re-orders the TUI + web nav.
TAB_ORDER: list[str] = [
    "dashboard",
    "mesh",
    "gps",
    "sdr",
    "wifi_recon",
    "wifi_offensive",
    "net_recon",
    "sdr_offensive",
    "esp32_companion",
    "ops",
    "system",
    "audio",
]


def load_modules() -> list[ModuleBase]:
    """Import every module in TAB_ORDER and return instantiated ModuleBase objects."""
    mods: list[ModuleBase] = []
    for name in TAB_ORDER:
        mod = importlib.import_module(f"warlock.modules.{name}")
        cls = getattr(mod, "Module", None)
        if cls is None:
            raise ImportError(f"warlock.modules.{name} is missing a `Module` class")
        if not issubclass(cls, ModuleBase):
            raise TypeError(f"warlock.modules.{name}.Module does not subclass ModuleBase")
        mods.append(cls())
    return mods
