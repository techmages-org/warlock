"""Net Recon — stubbed module. Implementation pending.

See ``02-warlock-command-center.md`` for the full feature spec.
"""
from __future__ import annotations

from fastapi import APIRouter

from warlock.modules._base import ModuleBase


class Module(ModuleBase):
    id = "net_recon"
    label = "Net Recon"
    icon = "⚘"
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
        #   - arp-scan / netdiscover LAN sweep
        #   - nmap preset profiles (quick, top-1000, full-tcp, vuln)
        #   - Responder (engagement-gated) LLMNR/NBT-NS/MDNS poisoner
        #   - crackmapexec SMB/WinRM/SSH enum
        return r


TODO_ITEMS: list[str] = [
    'arp-scan / netdiscover LAN sweep',
    'nmap preset profiles (quick, top-1000, full-tcp, vuln)',
    'Responder (engagement-gated) LLMNR/NBT-NS/MDNS poisoner',
    'crackmapexec SMB/WinRM/SSH enum'
]
