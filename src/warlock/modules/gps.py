"""GPS — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "gps"
    label = "GPS"
    icon = "◎"
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
        #   - Live fix dashboard (lat/lon/alt/speed/HDOP/VDOP)
        #   - Sky view: ASCII polar plot of satellites with SNR bars
        #   - Chrony stratum + offset + PPS jitter histogram
        #   - GPX track log start/stop, export to ~/warlock/tracks/
        return r


TODO_ITEMS: list[str] = [
    'Live fix dashboard (lat/lon/alt/speed/HDOP/VDOP)',
    'Sky view: ASCII polar plot of satellites with SNR bars',
    'Chrony stratum + offset + PPS jitter histogram',
    'GPX track log start/stop, export to ~/warlock/tracks/'
]
