# Warlock — Complete Software Stack Spec

> The full software bill of the Warlock deck: the OS, the application stack, every
> capability module, the security/radio tooling, the signed-attestation crypto, and
> the services that run it. Companion to [docs/HARDWARE.md](HARDWARE.md); the
> [README](../README.md) is the tour and [OVERVIEW](OVERVIEW.md) is the build playbook.
>
> _Live inventory from the running deck (Debian 13 trixie, aarch64)._

## What the software is

**One FastAPI backend** exposing a **module registry** across red / blue / radio /
platform domains, fronted by **three front-ends** (React web UI, Ink terminal UI, and
the on-device **WaRL0c** AI operator) — all sharing one source of truth for state,
scope, and audit. Offense is inert until a human arms a scoped engagement; every audit
row is a cryptographically signed attestation.

## OS & runtime

| Layer | Detail |
|---|---|
| **OS** | Debian 13 (**trixie**), aarch64 |
| **Kernel** | `6.12.x-v8-16k+` (16 KB page size) |
| **Boot** | from **NVMe** (root migrated off eMMC) |
| **Python** | ≥ 3.11 (backend) |
| **Node.js** | local on the deck — runs the Ink TUI + the AI operator |
| **Time** | GPS **1 PPS** + `chrony` discipline; PCF85063A RTC fallback |

## Application stack

- **Backend (Python ≥ 3.11):** **FastAPI** (`>=0.115`) + **Uvicorn** (`[standard] >=0.32`), **Pydantic v2** (+ pydantic-settings), **SQLAlchemy** (SQLite state), `websockets` (the event bus), `httpx`, **Rich/Textual**, `psutil`, `PyYAML`, `meshtastic`.
- **Attestation crypto:** **`cryptography` ≥ 44** (Ed25519) + **`rfc8785`** (JCS canonicalization) — see the AAR section.
- **Front-end (web):** **React + Vite + Leaflet** (dark theme) — dashboard, guided wireless flow, SDR/ADS-B map, IDS pager, audit log.
- **Front-end (TUI):** **Ink** (TypeScript) — terminal UI, replaced the earlier Textual app.
- **AI operator (WaRL0c):** the **PI agent libraries** (`@earendil-works/pi-*`) with an OpenAI-compatible provider (e.g. Z.AI GLM Coding Plan); keys are operator-local, never committed.

## The module registry

One backend, ~21 modules. Offensive modules (🔒) are inert until a scoped engagement is armed.

| Domain | Modules | What they do |
|---|---|---|
| **Wireless — recon** | `wifi_recon`, `wifi_analyzer` | wardrive (airodump-ng, GPS-tagged); AirCheck-class survey + monitor-mode RSSI fox-hunt |
| **Wireless — offense** 🔒 | `wifi_offensive` | deauth, handshake/PMKID, evil-twin & karma (airbase-ng), WPS (reaver/bully) — scope-checked per op |
| **Wireless — defense** | `wireless_ids` | Kismet-driven rogue-AP / evil-twin / deauth-flood detection → alert pager |
| **Network** | `net_recon`, `nettools`, `netdiag`, `capture` | ARP/port scan + baseline-diff; LinkRunner-class link/path qualification; bounded `tshark` capture w/ expert info |
| **Radio (SDR)** | `sdr`, `sdr_offensive` 🔒 | RTL-SDR RX, ADS-B aircraft intel; capture/replay/analyze — **transmit hard-gated** |
| **Mesh / comms** | `mesh`, `gps` | Meshtastic / LoRa SX1262 off-grid messaging; u-blox GPS w/ PPS |
| **Audit / blue** | `server_audit`, `report` | nmap-vuln, nikto, lynis, SSH-config review; engagement reporting |
| **Offline cracking** | `crack` | managed hashcat queue; auto-converts captures → `.hc22000` |
| **Platform** | `system`, `dashboard`, `ops`, `audio`, `voip`, `esp32_companion` | deck health, status, ops orchestration, audio/VoIP, Marauder ESP32 (USB-serial) |

## Security / wireless tooling (apt)

| Package | Version | Role |
|---|---|---|
| `kismet` | 2025-09-R1 | wireless IDS / capture |
| `aircrack-ng` | 1.7 | wifi recon/attack suite (airodump, airbase, aireplay) |
| `hcxdumptool` / `hcxtools` | 6.3.5 | PMKID/handshake capture + `hcxpcapngtool` conversion |
| `hashcat` | 6.2.6 | GPU/CPU password cracking |
| `reaver` / `bully` | 1.6.6 / 1.4 | WPS attacks |
| `nmap` | 7.95 | port/vuln scanning |
| `nikto` | 2.1.5 | web server scanning |
| `lynis` | 3.1.4 | host hardening audit |
| `bettercap` | 2.33.0 | network recon / MITM framework |
| `sshpass` | — | non-interactive SSH for audits (env-passed, never logged) |

*(Absent by design: `eaphammer`, `urh_cli` are not installed; `airodump-ng` ships with aircrack-ng.)*

## Radio / SDR / mesh / time tooling (apt)

| Package | Version | Role |
|---|---|---|
| `rtl-sdr` | 2.0.2 | RTL-SDR receive (ADS-B, scanning) |
| `hackrf` | 2024.02.1 | HackRF TX/RX (capture/replay) |
| `soapysdr-tools` | 0.8.1 | SDR abstraction |
| `readsb` | service | ADS-B decoder → `:8504/data/aircraft.json` |
| `meshtasticd` | 2.7.15 | Meshtastic / LoRa daemon (region US) |
| `gpsd` | 3.25 | GPS daemon (u-blox on `/dev/ttyAMA0`) |
| `chrony` | 4.6.1 | GPS+PPS time discipline |

## Signed attestation — AAR (Agent Attestation Record)

Every gated audit row is also emitted as a cryptographically signed proof:
- **Ed25519** signature (via `cryptography ≥ 44`), **JCS** canonicalization (`rfc8785`), **`did:web`** identity (subject = the deck, principal = the authorizing org).
- **Verifiable offline** against a reference verifier — *verifying must never let you forge*.
- **L1** = signed record; **L3** = transparency-log inclusion (a `log` receipt) when a log host is configured.
- API: `GET /api/aar/status|records|did.json`, `POST /api/aar/push`.

## Services / systemd

| Unit | Role |
|---|---|
| `warlock.service` | the platform — `python -m warlock` (FastAPI on `:7777`) |
| `meshtasticd` | LoRa mesh daemon |
| `gpsd` + `chrony` | GPS + PPS time discipline |
| `readsb` | ADS-B decoder service |
| `aiov2-gps-on` / `aiov2-lora-on` / `aiov2-internal-usb-on` | bring up AIO V2 GPIO power rails at boot |

Driver notes: RTL-SDR kernel DVB driver (`dvb_usb_rtl28xxu`) **blacklisted** so userspace owns the radio; LoRa SX1262 on `spidev1.0`; internal RTC disabled in favor of the PCF85063A.

## The safety model (software)

- **Safe by default** — offensive/transmit modules are inert until a scoped engagement is armed.
- **Scope enforced at execution time** — host/subnet/SSID/BSSID checked on every action, *including* when the AI makes the request.
- **Kill switch** — one call cancels every in-flight job across all queues and restores safe state (`POST /api/engagements/killswitch`).
- **AI cannot self-authorize** — WaRL0c acts only inside an engagement a human armed.

Full request/verify flow + the event bus are in [OVERVIEW §2](OVERVIEW.md).

## Verify, don't assume

Each subsystem ships a health probe: RTC `hwclock -r`, GPS `cgps`, PPS `ppstest`, SDR `rtl_test`, mesh `systemctl is-active meshtasticd`, Wi-Fi monitor `iw dev`, API `GET /api/health`.
