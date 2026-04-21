"""ESP32 Companion — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "esp32_companion"
    label = "ESP32 Companion"
    icon = "⌁"
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
        #   - Detect /dev/ttyUSB* / /dev/ttyACM* serial devices
        #   - Bridge Marauder serial command set → Warlock UI
        #   - Unlocks BLE spam / ultra-fast channel hop
        return r


TODO_ITEMS: list[str] = [
    'Detect /dev/ttyUSB* / /dev/ttyACM* serial devices',
    'Bridge Marauder serial command set → Warlock UI',
    'Unlocks BLE spam / ultra-fast channel hop'
]
