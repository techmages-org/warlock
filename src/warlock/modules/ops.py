"""Operations — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "ops"
    label = "Operations"
    icon = "◆"
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
        #   - New engagement wizard (name / auth / scope / duration)
        #   - Active engagement status + End button (already in /api/engagements)
        #   - History of past engagements + report regeneration
        #   - Pentest-style markdown + PDF report generator
        #   - Audit log viewer (searchable)
        return r


TODO_ITEMS: list[str] = [
    'New engagement wizard (name / auth / scope / duration)',
    'Active engagement status + End button (already in /api/engagements)',
    'History of past engagements + report regeneration',
    'Pentest-style markdown + PDF report generator',
    'Audit log viewer (searchable)'
]
