"""Offensive SDR — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "sdr_offensive"
    label = "Offensive SDR"
    icon = "☢"
    requires_engagement = True

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status() -> dict:
            return {
                "module": self.id,
                "label": self.label,
                "status": "pending",
                "requires_engagement": self.requires_engagement,
                "todo": TODO_ITEMS,
            }

        # TODO: implement real routes:
        #   - Replay file preparation (RTL-SDR is RX-only; requires HackRF for TX)
        #   - Signal analysis for garage/TPMS/433MHz captures
        #   - Hook points for HackRF/LimeSDR when hardware arrives
        return r


TODO_ITEMS: list[str] = [
    'Replay file preparation (RTL-SDR is RX-only; requires HackRF for TX)',
    'Signal analysis for garage/TPMS/433MHz captures',
    'Hook points for HackRF/LimeSDR when hardware arrives'
]
