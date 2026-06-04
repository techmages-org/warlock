"""WiFi Recon — passive airodump-ng driver.

Drives ``airodump-ng`` on the MT7921 USB dongle in monitor mode and
serves parsed AP / STA / handshake inventories over HTTP. Purely
passive: no injection, no engagement gate required.

Workflow:
  1. POST /api/wifi_recon/start  → helper puts mon0 into monitor mode,
     spawns ``sudo airodump-ng --write-interval 2 -w <prefix> --output-format
     csv,pcap mon0`` in the background. PID stashed at /run/warlock/airodump.pid.
  2. GET /api/wifi_recon/aps      → parse the rolling <prefix>-01.csv.
  3. GET /api/wifi_recon/clients  → same CSV, second section.
  4. POST /api/wifi_recon/stop    → SIGTERM, wait, helper returns to managed.
"""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import shutil
import signal
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from warlock.config import get_settings
from warlock.modules._base import ModuleBase

log = logging.getLogger("warlock.wifi_recon")


PID_PATH = Path("/run/warlock/airodump.pid")
STATE_PATH = Path("/run/warlock/airodump.state")
MT_HELPER = "/usr/local/bin/wlan-mt7921"
AIRODUMP = shutil.which("airodump-ng") or "/usr/sbin/airodump-ng"
AIRCRACK = shutil.which("aircrack-ng") or "/usr/bin/aircrack-ng"

# --- spin-guard knobs / state -------------------------------------------------
# airodump-ng will peg a CPU core forever if its capture interface disappears:
# the MT7921 USB dongle re-enumerates on regulatory ops, and warlock's own
# monitor-cycle deletes wlan1 to create mon0. The watchdog below kills airodump
# and backs off if the capture iface vanishes/goes down or its output stalls.
_SYS_CLASS_NET = Path("/sys/class/net")
IFF_UP = 0x1  # netdev flag bit for "interface administratively up"
WATCHDOG_POLL_S = 3.0
WATCHDOG_STALL_S = 15.0

_watchdog_task: asyncio.Task | None = None
_last_stop_reason: str | None = None


def _captures_dir() -> Path:
    p = get_settings().data / "captures" / "wifi"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _handshakes_dir() -> Path:
    p = get_settings().data / "handshakes"
    p.mkdir(parents=True, exist_ok=True)
    return p


class StartBody(BaseModel):
    channels: str = Field(default="all", description="all|2.4|5|comma-list e.g. 1,6,11,36")
    iface: str | None = None  # override (defaults to mon0 via helper)


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
        import json

        return json.loads(STATE_PATH.read_text())
    except Exception:  # noqa: BLE001
        return {}


def _write_state(data: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    import json

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
    """True when the capture interface exists *and* is administratively up."""
    return _iface_exists(iface) and _iface_is_up(iface)


def _output_mtime(prefix: Path) -> float:
    """Newest mtime across airodump's rolling CSV/pcap output for this prefix.

    Returns 0.0 when nothing has been written yet. A value that stops advancing
    means airodump is no longer capturing (interface gone, or wedged/spinning).
    """
    newest = 0.0
    for pat in (f"{prefix.name}-*.csv", f"{prefix.name}-*.cap", f"{prefix.name}-*.pcap"):
        for p in prefix.parent.glob(pat):
            try:
                m = p.stat().st_mtime
            except OSError:
                continue
            if m > newest:
                newest = m
    return newest


def _latest_csv(prefix: Path) -> Path | None:
    # airodump writes <prefix>-01.csv, -02.csv on subsequent runs with same prefix.
    matches = sorted(
        prefix.parent.glob(f"{prefix.name}-*.csv"), key=lambda p: p.stat().st_mtime
    )
    return matches[-1] if matches else None


def _parse_airodump_csv(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (aps, clients). airodump CSV format has two sections
    separated by a blank line. First section: APs. Second: STAs.
    """
    aps: list[dict[str, Any]] = []
    clients: list[dict[str, Any]] = []
    if not path.exists():
        return aps, clients
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return aps, clients
    # Split: first blank-ish line between sections.
    lines = text.splitlines()
    # Find the blank separator: airodump emits exactly one blank line between the two tables.
    sep_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "":
            # next non-blank should be STATION header
            for j in range(i + 1, len(lines)):
                if lines[j].strip() == "":
                    continue
                if lines[j].lstrip().startswith("Station MAC"):
                    sep_idx = i
                break
            if sep_idx is not None:
                break
    ap_block = lines[: sep_idx] if sep_idx is not None else lines
    sta_block = lines[sep_idx + 1 :] if sep_idx is not None else []

    def _rows(block: list[str]) -> list[dict[str, str]]:
        buf = "\n".join(block)
        reader = csv.reader(io.StringIO(buf))
        rows: list[dict[str, str]] = []
        header: list[str] | None = None
        for row in reader:
            if not row or all(not c.strip() for c in row):
                continue
            if header is None:
                header = [h.strip() for h in row]
                continue
            if len(row) < len(header):
                row = row + [""] * (len(header) - len(row))
            rows.append({header[i]: row[i].strip() for i in range(len(header))})
        return rows

    for row in _rows(ap_block):
        bssid = row.get("BSSID", "")
        if not bssid or bssid.upper() == "BSSID":
            continue
        try:
            power = int(row.get("Power") or 0)
        except ValueError:
            power = 0
        try:
            channel = int(row.get(" channel") or row.get("channel") or 0)
        except ValueError:
            channel = 0
        try:
            beacons = int(row.get(" # beacons") or row.get("# beacons") or 0)
        except ValueError:
            beacons = 0
        try:
            ivs = int(row.get(" # IV") or row.get("# IV") or 0)
        except ValueError:
            ivs = 0
        enc = (row.get(" Privacy") or row.get("Privacy") or "").strip()
        cipher = (row.get(" Cipher") or row.get("Cipher") or "").strip()
        auth = (row.get(" Authentication") or row.get("Authentication") or "").strip()
        essid = (row.get(" ESSID") or row.get("ESSID") or "").strip()
        first_seen = (row.get(" First time seen") or row.get("First time seen") or "").strip()
        last_seen = (row.get(" Last time seen") or row.get("Last time seen") or "").strip()
        # WPS isn't reported directly by airodump; surface via Cipher/auth heuristics.
        wps = "WPS" in enc or "WPS" in auth
        aps.append(
            {
                "bssid": bssid.lower(),
                "essid": essid,
                "channel": channel,
                "encryption": enc,
                "cipher": cipher,
                "auth": auth,
                "signal": power,
                "beacons": beacons,
                "ivs": ivs,
                "first_seen": first_seen,
                "last_seen": last_seen,
                "wps": wps,
            }
        )

    for row in _rows(sta_block):
        sta = (row.get("Station MAC") or "").strip()
        if not sta or sta.upper() == "STATION MAC":
            continue
        try:
            power = int(row.get(" Power") or row.get("Power") or 0)
        except ValueError:
            power = 0
        try:
            packets = int(row.get(" # packets") or row.get("# packets") or 0)
        except ValueError:
            packets = 0
        bssid = (row.get(" BSSID") or row.get("BSSID") or "").strip().lower()
        probes = (row.get(" Probed ESSIDs") or row.get("Probed ESSIDs") or "").strip()
        clients.append(
            {
                "station": sta.lower(),
                "associated": bssid if bssid and bssid != "(not associated)" else None,
                "probes": [p.strip() for p in probes.split(",") if p.strip()],
                "power": power,
                "packets": packets,
                "first_seen": (row.get(" First time seen") or "").strip(),
                "last_seen": (row.get(" Last time seen") or "").strip(),
            }
        )
    return aps, clients


def _scan_handshakes() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    # check both handshakes dir and captures dir for .cap files with EAPOL.
    candidates: list[Path] = []
    for d in (_handshakes_dir(), _captures_dir()):
        candidates.extend(sorted(d.glob("*.cap")))
        candidates.extend(sorted(d.glob("*.pcap")))
    for p in candidates:
        st = p.stat()
        has_eapol = False
        networks: list[str] = []
        try:
            # aircrack-ng -J dumps JSON summaries of WPA handshakes found.
            # Simpler: parse `aircrack-ng <cap>` output for "1 handshake".
            res = subprocess.run(
                [AIRCRACK, p.as_posix()],
                capture_output=True,
                text=True,
                timeout=4,
            )
            blob = (res.stdout or "") + (res.stderr or "")
            if "handshake" in blob.lower() or "WPA" in blob:
                has_eapol = True
            for line in blob.splitlines():
                line = line.strip()
                # Very rough ESSID extraction
                if "WPA" in line and "(" in line and ")" in line:
                    networks.append(line)
        except Exception:  # noqa: BLE001
            pass
        out.append(
            {
                "path": p.as_posix(),
                "filename": p.name,
                "size_bytes": st.st_size,
                "mtime": datetime.utcfromtimestamp(st.st_mtime).isoformat(),
                "eapol": has_eapol,
                "networks": networks[:5],
            }
        )
    return out


async def _start_airodump(channels: str, iface: str | None) -> dict[str, Any]:
    if _is_running():
        raise HTTPException(409, "airodump already running")
    if not Path(AIRODUMP).exists():
        raise HTTPException(500, f"airodump-ng not found at {AIRODUMP}")

    # Ensure MT7921 in monitor mode via helper.
    helper_out = ""
    try:
        res = await asyncio.create_subprocess_exec(
            MT_HELPER, "monitor",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        outb, errb = await asyncio.wait_for(res.communicate(), timeout=10)
        helper_out = ((outb or b"") + (errb or b"")).decode("utf-8", errors="replace")
        if res.returncode != 0:
            raise HTTPException(500, f"wlan-mt7921 monitor failed: {helper_out.strip()}")
    except asyncio.TimeoutError as e:
        raise HTTPException(500, "wlan-mt7921 monitor timeout") from e

    iface = iface or "mon0"

    # Spin-guard (pre-launch): never spawn airodump against a missing/down capture
    # interface — it would peg a CPU core forever on a dead capture handle. The
    # helper above should have created mon0; if it isn't actually up, bail cleanly
    # and return the radio to managed rather than launching a spinner.
    if not _iface_ready(iface):
        try:
            res = await asyncio.create_subprocess_exec(
                MT_HELPER, "managed",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(res.communicate(), timeout=10)
        except Exception:  # noqa: BLE001
            log.warning("wlan-mt7921 managed cleanup (iface not ready) failed")
        raise HTTPException(
            500,
            f"capture interface {iface} is not up after monitor setup — "
            "refusing to launch airodump (would spin)",
        )

    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    prefix = _captures_dir() / f"airodump-{stamp}"
    argv: list[str] = [
        "sudo", "-n", AIRODUMP,
        "--write-interval", "2",
        "-w", prefix.as_posix(),
        "--output-format", "csv,pcap",
    ]
    if channels and channels.lower() not in {"all", "any"}:
        band_map = {"2.4": "bg", "5": "a"}
        if channels.lower() in band_map:
            argv.extend(["--band", band_map[channels.lower()]])
        else:
            argv.extend(["-c", channels])
    argv.append(iface)

    log_path = prefix.with_suffix(".log")
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
        "prefix": prefix.as_posix(),
        "iface": iface,
        "channels": channels,
        "started_at": datetime.utcnow().isoformat(),
        "argv": argv,
    }
    _write_state(state)
    _launch_watchdog(prefix, iface)
    log.info("airodump started pid=%s iface=%s prefix=%s", proc.pid, iface, prefix)
    return state


async def _teardown_airodump() -> dict[str, Any]:
    """Kill airodump (if any), clear state, and return the radio to managed mode.

    Safe to call repeatedly: a dead/absent pid and missing state are no-ops.
    """
    st = _read_state()
    pid = st.get("pid")
    killed = False
    if pid:
        try:
            os.kill(int(pid), signal.SIGTERM)
            killed = True
            # wait briefly for graceful shutdown
            for _ in range(10):
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
        res = await asyncio.create_subprocess_exec(
            MT_HELPER, "managed",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        outb, errb = await asyncio.wait_for(res.communicate(), timeout=10)
        helper_out = ((outb or b"") + (errb or b"")).decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        log.warning("wlan-mt7921 managed failed: %s", e)

    return {"ok": True, "killed": killed, "helper": helper_out.strip(), "prior_state": st}


def _cancel_watchdog() -> None:
    """Cancel the running watchdog task (no-op if none / if called from within it)."""
    global _watchdog_task
    task = _watchdog_task
    _watchdog_task = None
    if task is None or task.done():
        return
    try:
        current = asyncio.current_task()
    except RuntimeError:
        current = None
    if task is not current:
        task.cancel()


async def _stop_airodump() -> dict[str, Any]:
    _cancel_watchdog()
    return await _teardown_airodump()


async def _watchdog(
    prefix: Path,
    iface: str,
    *,
    poll_s: float = WATCHDOG_POLL_S,
    stall_s: float = WATCHDOG_STALL_S,
) -> None:
    """Spin-guard loop. While airodump runs, kill it and back off if the capture
    interface disappears / goes down, or if capture output stops growing for
    ``stall_s`` seconds. Never relaunches — re-arming requires an explicit start.
    """
    global _last_stop_reason
    started = time.monotonic()
    last_mtime = _output_mtime(prefix)
    last_advance = started
    while True:
        await asyncio.sleep(poll_s)
        if not _is_running():
            return  # airodump exited (e.g. via /stop) — nothing to guard
        reason: str | None = None
        if not _iface_ready(iface):
            reason = f"capture interface {iface} vanished or went down"
        else:
            mtime = _output_mtime(prefix)
            now = time.monotonic()
            if mtime > last_mtime:
                last_mtime = mtime
                last_advance = now
            elif (now - last_advance) >= stall_s and (now - started) >= stall_s:
                reason = f"capture output stalled for >{int(stall_s)}s"
        if reason is not None:
            log.warning("wifi_recon watchdog: %s — killing airodump and backing off", reason)
            _last_stop_reason = reason
            try:
                await _teardown_airodump()
            except Exception:  # noqa: BLE001
                log.exception("wifi_recon watchdog teardown failed")
            return


def _launch_watchdog(prefix: Path, iface: str) -> None:
    global _watchdog_task, _last_stop_reason
    _last_stop_reason = None
    _watchdog_task = asyncio.create_task(_watchdog(prefix, iface))


class Module(ModuleBase):
    id = "wifi_recon"
    label = "WiFi Recon"
    icon = "☰"
    requires_engagement = False

    async def on_shutdown(self) -> None:
        if _is_running():
            try:
                await _stop_airodump()
            except Exception:  # noqa: BLE001
                log.exception("wifi_recon shutdown stop failed")

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/api/wifi_recon", tags=[self.id])

        @r.get("/status")
        def status() -> dict[str, Any]:
            running = _is_running()
            st = _read_state() if running else {}
            aps, clients = ([], [])
            uptime = None
            if running:
                prefix = Path(st.get("prefix", ""))
                csv_path = _latest_csv(prefix)
                if csv_path:
                    aps, clients = _parse_airodump_csv(csv_path)
                started = st.get("started_at")
                if started:
                    try:
                        uptime = int(
                            (datetime.utcnow() - datetime.fromisoformat(started)).total_seconds()
                        )
                    except ValueError:
                        pass
            return {
                "ok": True,
                "running": running,
                "iface": st.get("iface"),
                "channels": st.get("channels"),
                "aps_seen": len(aps),
                "clients_seen": len(clients),
                "uptime_s": uptime,
                "prefix": st.get("prefix"),
                "started_at": st.get("started_at"),
                "last_stop_reason": _last_stop_reason,
            }

        @r.post("/start")
        async def start(body: StartBody | None = None) -> dict[str, Any]:
            body = body or StartBody()
            st = await _start_airodump(body.channels, body.iface)
            return {"ok": True, "state": st}

        @r.post("/stop")
        async def stop() -> dict[str, Any]:
            res = await _stop_airodump()
            return res

        @r.get("/aps")
        def aps() -> dict[str, Any]:
            st = _read_state()
            if not st:
                return {"ok": True, "aps": [], "running": False}
            csv_path = _latest_csv(Path(st.get("prefix", "")))
            if not csv_path:
                return {"ok": True, "aps": [], "running": _is_running()}
            aps, _ = _parse_airodump_csv(csv_path)
            aps.sort(key=lambda a: -(a.get("signal") or -120))
            return {"ok": True, "aps": aps, "count": len(aps), "csv": csv_path.name}

        @r.get("/clients")
        def clients() -> dict[str, Any]:
            st = _read_state()
            if not st:
                return {"ok": True, "clients": [], "running": False}
            csv_path = _latest_csv(Path(st.get("prefix", "")))
            if not csv_path:
                return {"ok": True, "clients": [], "running": _is_running()}
            _, clients = _parse_airodump_csv(csv_path)
            clients.sort(key=lambda c: -(c.get("power") or -120))
            return {"ok": True, "clients": clients, "count": len(clients)}

        @r.get("/handshakes")
        def handshakes() -> dict[str, Any]:
            return {"ok": True, "handshakes": _scan_handshakes()}

        return r

    def tui_screen(self):  # type: ignore[no-untyped-def]
        from warlock.tui.screens.wifi_recon import WifiReconScreen

        return WifiReconScreen()
