"""SDR — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "sdr"
    label = "SDR"
    icon = "∿"
    requires_engagement = False

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
        #   - Scanner presets (FM / aviation / weather / ADS-B / ISM / POCSAG / VHF / 2m / 70cm)
        #   - dump1090 ADS-B background service + aircraft table
        #   - rtl_433 live decoded event feed
        #   - IQ recorder to ~/warlock/captures/iq/
        return r


TODO_ITEMS: list[str] = [
    'Scanner presets (FM / aviation / weather / ADS-B / ISM / POCSAG / VHF / 2m / 70cm)',
    'dump1090 ADS-B background service + aircraft table',
    'rtl_433 live decoded event feed',
    'IQ recorder to ~/warlock/captures/iq/'
]
