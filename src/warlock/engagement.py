"""Engagement mode: scope allowlist, audit log, kill switch."""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import yaml

from warlock import events
from warlock.config import get_settings

log = logging.getLogger("warlock.engagement")


def _emit_aar(kind: str, note: str, outcome: str) -> None:
    """Best-effort AAR proof for an engagement lifecycle event. Lazy-imported +
    fully guarded (aar imports engagement, so a top-level import would cycle; and
    a signing error must never break engagement start/stop)."""
    try:
        from warlock import aar

        aar.safe_emit_for_audit(kind=kind, command="", target="", note=note, outcome=outcome)
    except Exception:  # noqa: BLE001 — AAR is additive
        log.warning("AAR emit hook failed (non-fatal) for %s", kind, exc_info=True)


@dataclass
class ScopeAllowlist:
    ssids: list[str] = field(default_factory=list)
    bssids: list[str] = field(default_factory=list)
    ip_ranges: list[str] = field(default_factory=list)  # CIDRs

    def to_dict(self) -> dict:
        return {"ssids": self.ssids, "bssids": self.bssids, "ip_ranges": self.ip_ranges}

    def matches(self, target: str) -> bool:
        if not target:
            return False
        t = target.strip().lower()
        if t in {s.lower() for s in self.ssids}:
            return True
        if t in {b.lower() for b in self.bssids}:
            return True
        # Bare IP target: in scope iff it falls inside any scope CIDR.
        try:
            ip = ipaddress.ip_address(t)
        except ValueError:
            ip = None
        if ip is not None:
            for cidr in self.ip_ranges:
                try:
                    if ip in ipaddress.ip_network(cidr, strict=False):
                        return True
                except ValueError:
                    continue
            return False
        # CIDR target: in scope iff it is FULLY CONTAINED by a scope CIDR — so an
        # in-scope /23 under a /22 scope is allowed (a wider subnet, e.g. a /23
        # vs a /24 scope, is NOT contained and is correctly denied). subnet_of
        # raises TypeError across IP versions, so guard on matching versions.
        try:
            tnet = ipaddress.ip_network(t, strict=False)
        except ValueError:
            tnet = None
        if tnet is not None:
            for cidr in self.ip_ranges:
                try:
                    snet = ipaddress.ip_network(cidr, strict=False)
                except ValueError:
                    continue
                if tnet.version == snet.version and tnet.subnet_of(snet):
                    return True
        # Fallback: a non-IP target (or a CIDR typed verbatim into the allowlist).
        if t in {c.lower() for c in self.ip_ranges}:
            return True
        return False


class EngagementMode:
    """Singleton engagement state. `engagement` module-level alias below."""

    def __init__(self) -> None:
        self._mode: str = "off"  # "off" | "on"
        self.engagement_id: str | None = None
        self.name: str = ""
        self.auth_statement: str = ""
        self.scope: ScopeAllowlist = ScopeAllowlist()
        self.started_at: datetime | None = None
        self.audit_log_path: Path | None = None

    # --- state ---
    def is_on(self) -> bool:
        return self._mode == "on"

    def status(self) -> dict:
        return {
            "mode": self._mode,
            "engagement_id": self.engagement_id,
            "name": self.name,
            "scope": self.scope.to_dict(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
        }

    # --- lifecycle ---
    async def activate(
        self,
        *,
        name: str,
        auth_statement: str,
        scope: ScopeAllowlist,
        engagement_id: str | None = None,
    ) -> str:
        if self._mode == "on":
            raise RuntimeError("engagement already active")
        if not name.strip():
            raise ValueError("engagement name required")
        if not auth_statement.strip():
            raise ValueError("auth_statement required (paste scope letter or describe lab env)")
        if not (scope.ssids or scope.bssids or scope.ip_ranges):
            raise ValueError("scope allowlist must include at least one SSID / BSSID / IP range")

        self.engagement_id = engagement_id or str(uuid4())
        self.name = name
        self.auth_statement = auth_statement
        self.scope = scope
        self.started_at = datetime.utcnow()
        self._mode = "on"

        settings = get_settings()
        edir = settings.engagement_dir() / self.engagement_id
        edir.mkdir(parents=True, exist_ok=True)
        self.audit_log_path = edir / "audit.log"
        (edir / "engagement.yaml").write_text(
            yaml.safe_dump(
                {
                    "id": self.engagement_id,
                    "name": name,
                    "auth_statement": auth_statement,
                    "scope": scope.to_dict(),
                    "started_at": self.started_at.isoformat(),
                }
            )
        )
        self._append_audit("ENGAGEMENT_STARTED", {"name": name})
        # Engagement-as-grant (B3): mint a principal-signed acp_grant before the first AAR so
        # every attestation under this engagement carries its grant_ref (scope binding).
        from warlock.aar import grant as _grant
        _grant.mint_grant(engagement_id=self.engagement_id, scope=scope, name=name)
        _emit_aar("engagement.started", f"engagement {name!r} id={self.engagement_id}", "started")
        await events.bus.publish(
            events.ENGAGEMENT_STARTED,
            {"engagement_id": self.engagement_id, "name": name, "scope": scope.to_dict()},
        )
        return self.engagement_id

    def add_scope_targets(self, delta: ScopeAllowlist) -> dict:
        """Append targets to the ACTIVE engagement's scope (deduped, in-place).

        Used to authorize a freshly-recon'd AP/host without ending the
        engagement. BSSIDs are stored lowercase to stay consistent with
        ``matches()`` (which lowercases on compare) and the ``_split_targets``
        convention; SSIDs / IP ranges keep their form but are deduped
        case-insensitively (matches() is already case-insensitive). The
        engagement.yaml scope block is rewritten and a ``SCOPE_ADDED`` audit
        entry is appended. Returns the full updated scope dict.
        """
        if not self.is_on():
            raise RuntimeError("no active engagement")

        def _merge(existing: list[str], incoming: list[str], *, lower: bool) -> list[str]:
            out = list(existing)
            seen = {x.lower() for x in existing}
            for raw in incoming:
                v = raw.lower() if lower else raw
                key = v.lower()
                if not v or key in seen:
                    continue
                seen.add(key)
                out.append(v)
            return out

        self.scope.ssids = _merge(self.scope.ssids, delta.ssids, lower=False)
        self.scope.bssids = _merge(self.scope.bssids, delta.bssids, lower=True)
        self.scope.ip_ranges = _merge(self.scope.ip_ranges, delta.ip_ranges, lower=False)

        # Rewrite the engagement.yaml scope block, preserving every other key.
        settings = get_settings()
        edir = settings.engagement_dir() / self.engagement_id  # type: ignore[operator]
        ypath = edir / "engagement.yaml"
        try:
            data = yaml.safe_load(ypath.read_text()) if ypath.exists() else {}
        except Exception:  # noqa: BLE001 — a corrupt yaml must not block the mutation
            data = {}
        if not isinstance(data, dict):
            data = {}
        data["scope"] = self.scope.to_dict()
        edir.mkdir(parents=True, exist_ok=True)
        ypath.write_text(yaml.safe_dump(data))

        self._append_audit("SCOPE_ADDED", {"added": delta.to_dict()})
        return self.scope.to_dict()

    async def end(self) -> None:
        if self._mode == "off":
            return
        eid = self.engagement_id
        self._append_audit("ENGAGEMENT_ENDED", {})
        _emit_aar("engagement.ended", f"engagement id={eid}", "ended")
        self._mode = "off"
        from warlock.aar import grant as _grant
        _grant.clear_active()  # grant_ref no longer stamped once the engagement closes
        await events.bus.publish(events.ENGAGEMENT_ENDED, {"engagement_id": eid})
        self.engagement_id = None
        self.name = ""
        self.auth_statement = ""
        self.scope = ScopeAllowlist()
        self.started_at = None
        self.audit_log_path = None

    async def killswitch(self) -> dict:
        """Cancel everything, restore interfaces to managed, dump state."""
        from warlock.jobs import runner

        cancelled = await runner.cancel_all()

        # The shared runner only owns its OWN processes. The crack queue and the
        # server_audit queue run their own managed async queues, so the emergency
        # killswitch must reach into each directly or in-flight crack jobs and
        # remote audits keep running. Imports are lazy (avoids a circular import:
        # those modules import engagement for gating) and each module is guarded
        # independently — a missing or broken module must NEVER break the
        # killswitch or stop the other queues from being cancelled.
        crack_cancelled = 0
        try:
            from warlock.modules import crack

            crack_cancelled = await crack.queue.cancel_all()
        except Exception as e:  # noqa: BLE001
            log.warning("killswitch: crack queue cancel failed: %s", e)

        audit_cancelled = 0
        try:
            from warlock.modules import server_audit

            audit_cancelled = await server_audit.queue.cancel_all()
        except Exception as e:  # noqa: BLE001
            log.warning("killswitch: server_audit queue cancel failed: %s", e)

        restored = _restore_interfaces_to_managed()

        eid = self.engagement_id
        line = {
            "ts": datetime.utcnow().isoformat(),
            "cancelled_jobs": cancelled,
            "crack_jobs_cancelled": crack_cancelled,
            "audit_jobs_cancelled": audit_cancelled,
            "interfaces_restored": restored,
            "engagement_id": eid,
        }
        log.info(
            "killswitch: cancelled runner=%s crack=%s audit=%s; interfaces_restored=%s",
            cancelled,
            crack_cancelled,
            audit_cancelled,
            restored,
        )
        # Log to engagement dir if engaged, else to the data root.
        settings = get_settings()
        if eid:
            kpath = settings.engagement_dir() / eid / "killswitch.log"
        else:
            kpath = settings.data / "killswitch.log"
        kpath.parent.mkdir(parents=True, exist_ok=True)
        with kpath.open("a", encoding="utf-8") as f:
            f.write(yaml.safe_dump([line], sort_keys=False))

        await events.bus.publish(events.KILLSWITCH_PRESSED, line)
        return line

    # --- gating ---
    def check_target(self, target: str) -> bool:
        if not self.is_on():
            return False
        return self.scope.matches(target)

    # --- internals ---
    def _append_audit(self, kind: str, data: dict) -> None:
        if not self.audit_log_path:
            return
        entry = {"ts": datetime.utcnow().isoformat(), "kind": kind, **data}
        with self.audit_log_path.open("a", encoding="utf-8") as f:
            f.write(yaml.safe_dump([entry], sort_keys=False))


def _restore_interfaces_to_managed() -> list[str]:
    """Best-effort: return any monitor-mode ifaces to managed. Swallows errors."""
    restored: list[str] = []
    # Attempt via NetworkManager helper if present, then fallback to `iw`.
    helper = shutil.which("wlan-mt7921")  # phase-2 installed helper may exist
    try:
        if helper:
            subprocess.run([helper, "managed"], check=False, timeout=10)
            restored.append(helper + " managed")
    except Exception as e:  # noqa: BLE001
        log.warning("helper failed: %s", e)

    # Generic fallback — iterate known interface names.
    for iface in ("wlan0", "wlan1"):
        if not Path(f"/sys/class/net/{iface}").exists():
            continue
        try:
            subprocess.run(["iw", "dev", iface, "set", "type", "managed"], check=False, timeout=5)
            restored.append(f"iw {iface} managed")
        except Exception as e:  # noqa: BLE001
            log.warning("iw restore on %s failed: %s", iface, e)
    return restored


engagement = EngagementMode()


# Async-safe lock used by API handlers that mutate engagement state.
engagement_lock = asyncio.Lock()
