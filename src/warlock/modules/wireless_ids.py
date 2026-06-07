"""Wireless IDS — blue-team, kismet-driven WiFi intrusion detection.

DEFENSIVE / passive. Drives ``kismet`` on the MT7921 USB dongle in monitor
mode and reads kismet's REST API (devices + alerts engine) to surface:

  * **rogue / unknown AP** — a BSSID broadcasting an SSID *outside* the
    operator-set allowlist;
  * **evil-twin** — an *allowlisted* SSID broadcast by an unrecognized BSSID
    (when a BSSID baseline is set) or by 2+ distinct BSSIDs (no baseline);
  * **deauth / disassoc flood** — mgmt-frame floods from kismet's alert engine
    (DEAUTHFLOOD / BCASTDISCON / DISASSOCTRAFFIC …).

This module never injects and requires no engagement gate
(``requires_engagement = False``) — monitoring is always allowed. It stays
behind the same API basic-auth as every other module and only *reads* from
kismet's REST API.

Workflow:
  1. POST /api/wireless_ids/start  → helper puts the radio into monitor mode
     (``wlan-mt7921 monitor``), then launches kismet headless against that
     iface. kismet serves its REST API on 127.0.0.1:2501.
  2. GET  /api/wireless_ids/detections → pull kismet ``/devices`` + ``/alerts``,
     classify against the SSID/BSSID allowlist.
  3. GET/POST /api/wireless_ids/allowlist → operator-managed trusted SSIDs/BSSIDs.
  4. POST /api/wireless_ids/stop → SIGTERM kismet, helper returns radio to managed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from warlock import events
from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.wireless_ids")

PID_PATH = Path("/run/warlock/kismet.pid")
STATE_PATH = Path("/run/warlock/kismet.state")
MT_HELPER = "/usr/local/bin/wlan-mt7921"
KISMET = shutil.which("kismet") or "/usr/bin/kismet"

# Kismet REST API (its own embedded HTTP server). Creds default to kismet's
# convention; the operator configures them in kismet_httpd.conf / first-run.
KISMET_HOST = os.environ.get("WARLOCK_KISMET_HOST", "127.0.0.1")
KISMET_PORT = int(os.environ.get("WARLOCK_KISMET_PORT", "2501"))
KISMET_USER = os.environ.get("WARLOCK_KISMET_USER", "kismet")
KISMET_PASS = os.environ.get("WARLOCK_KISMET_PASS", "kismet")
KISMET_TIMEOUT = 6.0

_SYS_CLASS_NET = Path("/sys/class/net")
IFF_UP = 0x1  # netdev flag bit for "interface administratively up"

# Field-simplification aliases requested from kismet's /devices endpoint. Keeps
# the response tiny and the parsing trivial — kismet echoes the alias as the key.
DEVICE_FIELDS: list[list[str]] = [
    ["kismet.device.base.macaddr", "mac"],
    ["kismet.device.base.type", "type"],
    ["kismet.device.base.channel", "channel"],
    ["kismet.device.base.signal/kismet.common.signal.last_signal", "signal"],
    ["kismet.device.base.first_time", "first_time"],
    ["kismet.device.base.last_time", "last_time"],
    ["kismet.device.base.commonname", "name"],
    ["dot11.device/dot11.device.last_beaconed_ssid", "ssid"],
]

# Kismet alert headers that indicate a mgmt-frame / deauth-disassoc flood.
_FLOOD_TOKENS = ("DEAUTH", "DISASSOC", "DISCON")

_SEVERITY_RANK = {"high": 3, "medium": 2, "low": 1, "info": 0}

# Detection kinds we fan into the system-wide ALERT_FIRED bus (the activity
# pager). Generic low-severity ``kismet_alert`` rows are intentionally excluded —
# only actionable IDS hits page the operator.
_ALERTABLE_TYPES = ("rogue_ap", "evil_twin", "deauth_flood")


# --------------------------------------------------------------------------- #
# allowlist persistence
# --------------------------------------------------------------------------- #
def _allowlist_path() -> Path:
    p = get_settings().data / "wireless_ids"
    p.mkdir(parents=True, exist_ok=True)
    return p / "allowlist.json"


def _read_allowlist() -> dict[str, list[str]]:
    path = _allowlist_path()
    if not path.exists():
        return {"ssids": [], "bssids": []}
    try:
        data = json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return {"ssids": [], "bssids": []}
    return {
        "ssids": [str(s) for s in data.get("ssids", []) if str(s).strip()],
        "bssids": [str(b).lower() for b in data.get("bssids", []) if str(b).strip()],
    }


def _write_allowlist(ssids: list[str], bssids: list[str]) -> dict[str, list[str]]:
    # De-dupe, preserve order, normalize bssids to lowercase.
    seen_s: set[str] = set()
    clean_s: list[str] = []
    for s in ssids:
        s = str(s).strip()
        if s and s.lower() not in seen_s:
            seen_s.add(s.lower())
            clean_s.append(s)
    seen_b: set[str] = set()
    clean_b: list[str] = []
    for b in bssids:
        b = str(b).strip().lower()
        if b and b not in seen_b:
            seen_b.add(b)
            clean_b.append(b)
    data = {"ssids": clean_s, "bssids": clean_b}
    _allowlist_path().write_text(json.dumps(data, indent=2))
    return data


# --------------------------------------------------------------------------- #
# kismet REST helpers
# --------------------------------------------------------------------------- #
def _kismet_base_url() -> str:
    return f"http://{KISMET_HOST}:{KISMET_PORT}"


def _kismet_auth() -> tuple[str, str]:
    return (KISMET_USER, KISMET_PASS)


async def _kismet_get_json(path: str) -> Any:
    # AsyncClient (not httpx.Client) so a kismet REST call NEVER blocks the event
    # loop — a slow/hung kismet would otherwise freeze every other request
    # (including the killswitch) for up to KISMET_TIMEOUT seconds per call.
    async with httpx.AsyncClient(timeout=KISMET_TIMEOUT) as c:
        r = await c.get(_kismet_base_url() + path, auth=_kismet_auth())
        r.raise_for_status()
        return r.json()


async def _kismet_post_json(path: str, payload: dict[str, Any]) -> Any:
    # Kismet accepts a form-encoded ``json`` POST variable for field-simplified queries.
    async with httpx.AsyncClient(timeout=KISMET_TIMEOUT) as c:
        r = await c.post(
            _kismet_base_url() + path,
            auth=_kismet_auth(),
            data={"json": json.dumps(payload)},
        )
        r.raise_for_status()
        return r.json()


async def _fetch_devices() -> list[dict[str, Any]]:
    """Return kismet devices (field-simplified). Raises on REST failure."""
    data = await _kismet_post_json("/devices/views/all/devices.json", {"fields": DEVICE_FIELDS})
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    if isinstance(data, dict):
        # Some kismet builds wrap the vector under a key.
        for v in data.values():
            if isinstance(v, list):
                return [d for d in v if isinstance(d, dict)]
    return []


async def _fetch_alerts() -> list[dict[str, Any]]:
    """Return kismet alerts. Raises on REST failure."""
    data = await _kismet_get_json("/alerts/all_alerts.json")
    if isinstance(data, dict):
        lst = data.get("kismet.alert.list")
        if isinstance(lst, list):
            return [a for a in lst if isinstance(a, dict)]
        for v in data.values():
            if isinstance(v, list):
                return [a for a in v if isinstance(a, dict)]
        return []
    if isinstance(data, list):
        return [a for a in data if isinstance(a, dict)]
    return []


# --------------------------------------------------------------------------- #
# pure parsing / classification (the testable core)
# --------------------------------------------------------------------------- #
def _field(d: dict[str, Any], *keys: str, default: Any = None) -> Any:
    """First present, non-None value across alias + full dotted kismet keys."""
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _ts_iso(value: Any) -> str | None:
    """Convert a kismet unix epoch (int/float seconds) to an ISO-8601 string."""
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    try:
        return datetime.utcfromtimestamp(ts).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_ap(d: dict[str, Any]) -> bool:
    t = str(_field(d, "type", "kismet.device.base.type", default="")).lower()
    return "ap" in t  # "Wi-Fi AP", "Wi-Fi Device AP", etc.


def _extract_ap(d: dict[str, Any]) -> dict[str, Any]:
    bssid = str(_field(d, "mac", "kismet.device.base.macaddr", default="")).lower()
    ssid = str(_field(d, "ssid", "name", "kismet.device.base.commonname", default="") or "").strip()
    # kismet uses sentinel commonname == macaddr for nameless devices; treat as hidden.
    if ssid.lower() == bssid or ssid == "0.0.0.0":
        ssid = ""
    return {
        "bssid": bssid,
        "ssid": ssid,
        "channel": _to_int(_field(d, "channel", "kismet.device.base.channel")),
        "signal": _to_int(_field(d, "signal", "kismet.common.signal.last_signal")),
        "first_seen": _ts_iso(_field(d, "first_time", "kismet.device.base.first_time")),
        "last_seen": _ts_iso(_field(d, "last_time", "kismet.device.base.last_time")),
    }


def _detection(
    *,
    dtype: str,
    severity: str,
    bssid: str,
    ssid: str,
    detail: str,
    channel: int | None = None,
    signal: int | None = None,
    first_seen: str | None = None,
    last_seen: str | None = None,
    source: str = "analysis",
) -> dict[str, Any]:
    return {
        "type": dtype,
        "severity": severity,
        "bssid": bssid,
        "ssid": ssid,
        "channel": channel,
        "signal": signal,
        "detail": detail,
        "first_seen": first_seen,
        "last_seen": last_seen,
        "source": source,
    }


def _alert_dedup_key(det: dict[str, Any]) -> str:
    """Stable identity for a detection — ``bssid|kind``. Lets the module page a
    given (radio, finding) pair exactly once per capture session."""
    return f"{det.get('bssid') or ''}|{det.get('type') or ''}"


def _alert_message(det: dict[str, Any]) -> str:
    """Human one-liner for the pager feed, e.g. ``rogue AP 'FreeWiFi' ch1 <bssid>``."""
    ssid = (det.get("ssid") or "").strip()
    bssid = det.get("bssid") or ""
    ch = det.get("channel")
    chs = f" ch{ch}" if ch is not None else ""
    dtype = det.get("type")
    if dtype == "rogue_ap":
        return f"rogue AP '{ssid}'{chs} {bssid}".strip()
    if dtype == "evil_twin":
        return f"evil-twin '{ssid}'{chs} {bssid}".strip()
    if dtype == "deauth_flood":
        return f"deauth flood{chs} {bssid}".strip()
    return f"{dtype}{chs} {bssid}".strip()


def classify_devices(
    devices: list[dict[str, Any]],
    ssid_allowlist: list[str],
    bssid_allowlist: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Derive rogue-AP and evil-twin detections from kismet devices.

    Rules:
      * Empty SSID allowlist  -> no rogue/evil-twin flags (monitoring only).
      * SSID not in allowlist  -> rogue / unknown AP (medium).
      * SSID in allowlist, BSSID not in allowlist (when a BSSID baseline exists)
        -> evil-twin (high).
      * SSID in allowlist, no BSSID baseline, but 2+ distinct BSSIDs broadcast it
        -> evil-twin (high) on every conflicting BSSID.
    """
    allow_ssids = {s.strip().lower() for s in ssid_allowlist if s.strip()}
    allow_bssids = {b.strip().lower() for b in (bssid_allowlist or []) if b.strip()}
    if not allow_ssids:
        return []

    aps = [_extract_ap(d) for d in devices if _is_ap(d)]

    # Map each allowlisted SSID -> distinct BSSIDs broadcasting it (for the
    # no-baseline duplicate heuristic).
    bssids_for_ssid: dict[str, set[str]] = {}
    for ap in aps:
        sl = ap["ssid"].lower()
        if sl in allow_ssids and ap["bssid"]:
            bssids_for_ssid.setdefault(sl, set()).add(ap["bssid"])

    detections: list[dict[str, Any]] = []
    for ap in aps:
        bssid = ap["bssid"]
        ssid = ap["ssid"]
        sl = ssid.lower()
        if bssid and bssid in allow_bssids:
            continue  # explicitly trusted radio
        if not ssid:
            continue  # hidden / unnamed AP — not classifiable against an SSID allowlist

        common = {
            "bssid": bssid,
            "ssid": ssid,
            "channel": ap["channel"],
            "signal": ap["signal"],
            "first_seen": ap["first_seen"],
            "last_seen": ap["last_seen"],
            "source": "analysis",
        }

        if sl in allow_ssids:
            if allow_bssids:
                # Baseline exists and this BSSID isn't on it -> evil-twin.
                detections.append(_detection(
                    dtype="evil_twin", severity="high",
                    detail=f"Allowlisted SSID '{ssid}' broadcast by unrecognized BSSID {bssid}",
                    **common,
                ))
            elif len(bssids_for_ssid.get(sl, set())) > 1:
                # No baseline, but multiple radios claim the same trusted SSID.
                n = len(bssids_for_ssid[sl])
                detections.append(_detection(
                    dtype="evil_twin", severity="high",
                    detail=(f"Allowlisted SSID '{ssid}' seen on {n} distinct BSSIDs "
                            f"(possible evil-twin); this one is {bssid}"),
                    **common,
                ))
            # else: single BSSID for a trusted SSID -> legitimate, no detection.
        else:
            detections.append(_detection(
                dtype="rogue_ap", severity="medium",
                detail=f"AP broadcasting unlisted SSID '{ssid}'",
                **common,
            ))
    return detections


def classify_alerts(alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map kismet alert-engine records to detections (deauth/disassoc floods etc.)."""
    detections: list[dict[str, Any]] = []
    for a in alerts:
        header = str(_field(a, "kismet.alert.header", "header", default="")).upper()
        text = str(_field(a, "kismet.alert.text", "text", default="")).strip()
        ts = _ts_iso(_field(a, "kismet.alert.timestamp", "timestamp"))
        bssid = str(_field(
            a, "kismet.alert.transmitter_mac", "kismet.alert.source_mac",
            "kismet.alert.bssid", "source_mac", default="",
        ) or "").lower()
        channel = _to_int(_field(a, "kismet.alert.channel", "channel"))
        is_flood = any(tok in header for tok in _FLOOD_TOKENS)
        detections.append(_detection(
            dtype="deauth_flood" if is_flood else "kismet_alert",
            severity="high" if is_flood else "low",
            bssid=bssid,
            ssid="",
            channel=channel,
            detail=text or header or "kismet alert",
            first_seen=ts,
            last_seen=ts,
            source="kismet_alert",
        ))
    return detections


def _sort_detections(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        detections,
        key=lambda d: (_SEVERITY_RANK.get(d.get("severity", "info"), 0), d.get("last_seen") or ""),
        reverse=True,
    )


# --------------------------------------------------------------------------- #
# kismet process lifecycle
# --------------------------------------------------------------------------- #
class StartBody(BaseModel):
    iface: str | None = None  # capture iface (defaults to mon0 via the helper)
    channels: str = Field(default="all", description="all|hop-list e.g. 1,6,11")


class AllowlistBody(BaseModel):
    ssids: list[str] = Field(default_factory=list)
    bssids: list[str] = Field(default_factory=list)


def _is_running() -> bool:
    if not PID_PATH.exists():
        return False
    try:
        pid = int(PID_PATH.read_text().strip() or "0")
    except ValueError:
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _read_state() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:  # noqa: BLE001
        return {}


def _write_state(data: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(data))


def _clear_state() -> None:
    for p in (PID_PATH, STATE_PATH):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def _iface_exists(iface: str) -> bool:
    return (_SYS_CLASS_NET / iface).exists()


def _iface_is_up(iface: str) -> bool:
    try:
        flags = int((_SYS_CLASS_NET / iface / "flags").read_text().strip(), 16)
    except (OSError, ValueError):
        return False
    return bool(flags & IFF_UP)


def _iface_ready(iface: str) -> bool:
    return _iface_exists(iface) and _iface_is_up(iface)


async def _kismet_reachable() -> bool:
    try:
        await _kismet_get_json("/system/status.json")
        return True
    except Exception:  # noqa: BLE001
        return False


async def _run_helper(mode: str, timeout: float = 10.0) -> str:
    res = await asyncio.create_subprocess_exec(
        MT_HELPER, mode,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    outb, errb = await asyncio.wait_for(res.communicate(), timeout=timeout)
    out = ((outb or b"") + (errb or b"")).decode("utf-8", errors="replace")
    if res.returncode != 0:
        raise HTTPException(500, f"wlan-mt7921 {mode} failed: {out.strip()}")
    return out


async def _start_kismet(channels: str, iface: str | None) -> dict[str, Any]:
    if _is_running():
        raise HTTPException(409, "kismet already running")
    if not Path(KISMET).exists():
        raise HTTPException(500, f"kismet not found at {KISMET}")

    await _run_helper("monitor")
    iface = iface or "mon0"

    if not _iface_ready(iface):
        try:
            await _run_helper("managed")
        except Exception:  # noqa: BLE001
            log.warning("wlan-mt7921 managed cleanup (iface not ready) failed")
        raise HTTPException(
            500,
            f"capture interface {iface} is not up after monitor setup — refusing to launch kismet",
        )

    log_dir = get_settings().data / "wireless_ids"
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    log_path = log_dir / f"kismet-{stamp}.log"

    argv: list[str] = [
        "sudo", "-n", KISMET,
        "-c", iface,
        "--no-ncurses", "--silent",
        "--homedir", log_dir.as_posix(),
    ]
    if channels and channels.lower() not in {"all", "any"}:
        argv.extend(["--override", f"hop_channels={channels}"])

    import subprocess

    log_fh = log_path.open("w", encoding="utf-8")
    try:
        proc = subprocess.Popen(
            argv,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except FileNotFoundError as e:
        log_fh.close()
        raise HTTPException(500, f"spawn failed: {e}") from e

    PID_PATH.parent.mkdir(parents=True, exist_ok=True)
    PID_PATH.write_text(str(proc.pid))
    state = {
        "pid": proc.pid,
        "iface": iface,
        "channels": channels,
        "started_at": datetime.utcnow().isoformat(),
        "log": log_path.as_posix(),
    }
    _write_state(state)
    log.info("kismet started pid=%s iface=%s", proc.pid, iface)
    return state


async def _stop_kismet() -> dict[str, Any]:
    st = _read_state()
    pid = st.get("pid")
    killed = False
    if pid:
        try:
            os.kill(int(pid), signal.SIGTERM)
            killed = True
            for _ in range(15):
                await asyncio.sleep(0.2)
                try:
                    os.kill(int(pid), 0)
                except ProcessLookupError:
                    break
            else:
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        except ProcessLookupError:
            pass
        except Exception as e:  # noqa: BLE001
            log.warning("kill failed: %s", e)
    _clear_state()

    helper_out = ""
    try:
        helper_out = await _run_helper("managed")
    except Exception as e:  # noqa: BLE001
        log.warning("wlan-mt7921 managed failed: %s", e)

    return {"ok": True, "killed": killed, "helper": helper_out.strip(), "prior_state": st}


# --------------------------------------------------------------------------- #
# module
# --------------------------------------------------------------------------- #
class Module(ModuleBase):
    id = "wireless_ids"
    label = "Wireless IDS"
    icon = "🛡"
    requires_engagement = False  # defensive / passive monitoring — always allowed

    def __init__(self) -> None:
        super().__init__()
        # ``bssid|kind`` keys already fanned into the ALERT_FIRED bus this capture
        # session, so each NEW detection pages exactly once (no per-poll spam).
        self._published_alerts: set[str] = set()

    async def _publish_new_detections(self, dets: list[dict[str, Any]]) -> None:
        """Fan each NEW actionable detection into the ALERT_FIRED bus exactly once.

        Best-effort: a bus failure rolls back the dedup mark so the next poll can
        retry, and never propagates out of ``/detections``.
        """
        for det in dets:
            if det.get("type") not in _ALERTABLE_TYPES:
                continue
            key = _alert_dedup_key(det)
            if key in self._published_alerts:
                continue
            self._published_alerts.add(key)
            try:
                await events.bus.publish(
                    events.ALERT_FIRED,
                    {
                        "severity": det.get("severity", "medium"),
                        "source": self.id,
                        "message": _alert_message(det),
                    },
                )
            except Exception:  # noqa: BLE001 — pager fan-out must never break /detections
                self._published_alerts.discard(key)
                log.exception("wireless_ids: failed to publish ALERT_FIRED")

    async def on_shutdown(self) -> None:
        if _is_running():
            try:
                await _stop_kismet()
            except Exception:  # noqa: BLE001
                log.exception("wireless_ids shutdown stop failed")
        self._published_alerts.clear()

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.wireless_ids import WirelessIdsScreen

        return WirelessIdsScreen()

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/wireless_ids", tags=[self.id])

        @r.get("/status")
        async def status() -> dict[str, Any]:
            running = _is_running()
            st = _read_state() if running else {}
            uptime = None
            started = st.get("started_at")
            if started:
                try:
                    uptime = int(
                        (datetime.utcnow() - datetime.fromisoformat(started)).total_seconds()
                    )
                except ValueError:
                    pass
            allow = _read_allowlist()
            return {
                "ok": True,
                "running": running,
                "iface": st.get("iface"),
                "channels": st.get("channels"),
                "kismet_reachable": (await _kismet_reachable()) if running else False,
                "uptime_s": uptime,
                "started_at": started,
                "allowlist": {"ssids": len(allow["ssids"]), "bssids": len(allow["bssids"])},
            }

        @r.post("/start")
        async def start(body: StartBody | None = None) -> dict[str, Any]:
            body = body or StartBody()
            st = await _start_kismet(body.channels, body.iface)
            self._published_alerts.clear()  # fresh capture session → re-page hits
            return {"ok": True, "state": st}

        @r.post("/stop")
        async def stop() -> dict[str, Any]:
            result = await _stop_kismet()
            self._published_alerts.clear()  # reset dedup so a re-detect re-pages
            return result

        @r.get("/detections")
        async def detections() -> dict[str, Any]:
            allow = _read_allowlist()
            dets: list[dict[str, Any]] = []
            errors: list[str] = []
            try:
                devices = await _fetch_devices()
                dets.extend(classify_devices(devices, allow["ssids"], allow["bssids"]))
            except Exception as e:  # noqa: BLE001
                errors.append(f"devices: {e}")
            try:
                alerts = await _fetch_alerts()
                dets.extend(classify_alerts(alerts))
            except Exception as e:  # noqa: BLE001
                errors.append(f"alerts: {e}")
            dets = _sort_detections(dets)
            await self._publish_new_detections(dets)
            counts = {
                "rogue_ap": sum(1 for d in dets if d["type"] == "rogue_ap"),
                "evil_twin": sum(1 for d in dets if d["type"] == "evil_twin"),
                "deauth_flood": sum(1 for d in dets if d["type"] == "deauth_flood"),
                "kismet_alert": sum(1 for d in dets if d["type"] == "kismet_alert"),
            }
            return {
                "ok": not errors,
                "running": _is_running(),
                "count": len(dets),
                "counts": counts,
                "detections": dets,
                "errors": errors,
            }

        @r.get("/allowlist")
        def get_allowlist() -> dict[str, Any]:
            allow = _read_allowlist()
            return {"ok": True, **allow}

        @r.post("/allowlist")
        def post_allowlist(body: AllowlistBody) -> dict[str, Any]:
            data = _write_allowlist(body.ssids, body.bssids)
            return {"ok": True, **data}

        return r
