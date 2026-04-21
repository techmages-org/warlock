"""System — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "system"
    label = "System"
    icon = "⚙"
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
        #   - AIO V2 GPIO control (GPS/LoRa/SDR/Internal USB toggles)
        #   - Start/stop/status for meshtasticd/gpsd/chrony/kismet/dump1090/bettercap
        #   - Journalctl tail UI
        #   - Temps + power trend, throttle events
        #   - Network interface reset + WiFi scan
        return r


TODO_ITEMS: list[str] = [
    'AIO V2 GPIO control (GPS/LoRa/SDR/Internal USB toggles)',
    'Start/stop/status for meshtasticd/gpsd/chrony/kismet/dump1090/bettercap',
    'Journalctl tail UI',
    'Temps + power trend, throttle events',
    'Network interface reset + WiFi scan'
]
