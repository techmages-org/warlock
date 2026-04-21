# Warlock Command Center

Unified TUI + web command center for the uConsole field kit. Wraps the Stage 1
tool stack (Meshtastic, GPS, SDR, WiFi recon/offensive, pentest) into a single
coherent operator interface with engagement-mode gating, audit logging, and a
kill switch.

> **Status:** Phase 11 skeleton. `dashboard` and `mesh` are implemented
> end-to-end. The other 9 modules are stubbed with clear extension points.

## Layout

| Path | Purpose |
|---|---|
| `/opt/warlock/` | Code (this repo) |
| `~/warlock/` | Operator data (engagements, captures, tracks, handshakes, reports, wordlists) |
| `/etc/systemd/system/warlock.service` | Daemon unit |
| `/usr/local/bin/warlock` | CLI shim → Textual TUI |
| `/run/warlock/warlock.sock` | Unix socket for TUI ↔ daemon (planned) |

## Launching

Warlock runs as a systemd service (`warlock.service`) and starts automatically at boot. You never start or stop it manually.

**Three ways to use it:**
- **Desktop icons** — double-click **Warlock** (TUI) or **Warlock (Web)** on your desktop
- **App menu** — System > Warlock / Warlock (Web)
- **Terminal** — run `warlock` (TUI) or browse to `http://localhost:7777` (web)

To check service status:
`systemctl status warlock`

To restart after code changes:
`sudo systemctl restart warlock`

## Quick reference

```bash
# Service lifecycle
sudo systemctl start warlock
sudo systemctl status warlock
sudo journalctl -u warlock -f

# TUI
warlock

# Web UI (LAN)
open http://<uconsole-ip>:7777
```

## Configuration

Environment variables read at startup (see `src/warlock/config.py`):

| Var | Default | Purpose |
|---|---|---|
| `WARLOCK_DATA` | `/home/sem/warlock` | Operator data root |
| `WARLOCK_HOST` | `0.0.0.0` | Bind host for the HTTP API |
| `WARLOCK_PORT` | `7777` | HTTP port |
| `WARLOCK_WEB_PASSWORD` | `warlock` | **CHANGE ON FIRST USE.** HTTP basic-auth password for the web UI (username `warlock`). |
| `WARLOCK_MESH_HOST` | `127.0.0.1` | meshtasticd TCP host |
| `WARLOCK_MESH_PORT` | `4403` | meshtasticd native API port |
| `WARLOCK_GPSD_HOST` | `127.0.0.1` | gpsd host |
| `WARLOCK_GPSD_PORT` | `2947` | gpsd port |

## Engagement mode

- OFF by default. Only passive tools run.
- Activate via the TUI (`Ctrl+E`) or `POST /api/engagements` + `POST /api/engagements/{id}/activate`.
- Requires a populated scope allowlist (SSIDs / BSSIDs / IP ranges) and a free-text authorization statement.
- Every offensive command is logged to `~/warlock/engagements/<uuid>/audit.log` with timestamp, SHA-256 of the command invocation, and operator note.
- Kill switch: TUI `Ctrl+K` or `POST /api/engagements/killswitch`. Stops all active jobs, restores interfaces to managed mode, writes `killswitch.log`.

## Modules

| Module | Status | Purpose |
|---|---|---|
| `dashboard` | ✅ real | CPU/temp/GPS/chrony/mesh/engagement status tiles |
| `mesh` | ✅ real | Meshtastic node list, channels, send, packet tail |
| `gps` | 🟡 stub | Position & NTP |
| `sdr` | 🟡 stub | Radio scanner |
| `wifi_recon` | 🟡 stub | Passive WiFi intelligence |
| `wifi_offensive` | 🟡 stub (gated) | Active WiFi |
| `net_recon` | 🟡 stub | nmap / arp-scan / responder |
| `sdr_offensive` | 🟡 stub (gated) | RF attacks / replay |
| `esp32_companion` | 🟡 stub | ESP32-Marauder serial bridge |
| `ops` | 🟡 stub | Engagement lifecycle UI (machinery in `engagement.py`) |
| `system` | 🟡 stub | Hardware + services |

## Development

```bash
# Backend
cd /opt/warlock
uv venv --python 3.13
source .venv/bin/activate
uv pip install -e .[dev]
python -m warlock

# Web
cd /opt/warlock/web
eval "$(~/.local/share/fnm/fnm env)"
npm install
npm run dev
```

## Wordlists

`~/warlock/wordlists/` ships empty. See the README inside that directory for
seed instructions — deferred from Phase 11 due to eMMC disk pressure. Seed
after the M.2 NVMe migration (Phase 12).

## Operator tasks on first boot

1. `sudo systemctl status warlock` → confirm active.
2. `curl http://127.0.0.1:7777/api/health` → `{"ok":true}`.
3. `warlock` → TUI launches, dashboard renders.
4. Set `WARLOCK_WEB_PASSWORD` in `/etc/systemd/system/warlock.service.d/password.conf`:

   ```
   [Service]
   Environment=WARLOCK_WEB_PASSWORD=<strong-password>
   ```

   Then `sudo systemctl daemon-reload && sudo systemctl restart warlock`.
