"""WiFi Recon — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "wifi_recon"
    label = "WiFi Recon"
    icon = "☰"
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
        #   - Monitor-mode toggle for wlan1 (AC1200)
        #   - Kismet wrapper + AP/client live tables
        #   - Passive EAPOL handshake capture → ~/warlock/handshakes/
        #   - Wardriving CSV (WiGLE-compatible)
        return r


TODO_ITEMS: list[str] = [
    'Monitor-mode toggle for wlan1 (AC1200)',
    'Kismet wrapper + AP/client live tables',
    'Passive EAPOL handshake capture → ~/warlock/handshakes/',
    'Wardriving CSV (WiGLE-compatible)'
]
