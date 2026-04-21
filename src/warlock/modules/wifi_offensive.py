"""Offensive WiFi — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "wifi_offensive"
    label = "Offensive WiFi"
    icon = "⚠"
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
        #   - Deauth (aireplay-ng) scoped to allowlist
        #   - PMKID capture (hcxdumptool) + hc22000 conversion
        #   - Evil Twin + captive portal templates (hostapd-mana)
        #   - Karma / MANA / WPS (reaver, bully) / eaphammer
        #   - hashcat crack queue against ~/warlock/wordlists/
        return r


TODO_ITEMS: list[str] = [
    'Deauth (aireplay-ng) scoped to allowlist',
    'PMKID capture (hcxdumptool) + hc22000 conversion',
    'Evil Twin + captive portal templates (hostapd-mana)',
    'Karma / MANA / WPS (reaver, bully) / eaphammer',
    'hashcat crack queue against ~/warlock/wordlists/'
]
