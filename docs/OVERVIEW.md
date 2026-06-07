# Warlock OS — Complete Overview

> The full picture: what Warlock is, what it can do, how it works, every software
> package on the deck, and the hardware build. Authoritative technical doc for the
> flagship [TechMages.org](https://techmages.org) project (an open project of Titanium
> Computing). **Authorization-first** — see `CHARTER` at TechMages.org.

---

## 1. What it is

Warlock OS is a **field cyberdeck**: a self-contained, battery-powered security
workstation built on a ClockworkPi uConsole with a Raspberry Pi Compute Module 5. It
unifies wireless recon and offense, a wireless IDS, software-defined radio, off-grid
mesh comms, blue-team network/server auditing, offline password cracking, and an
on-device AI operator — **all behind one API, one authorization gate, and one signed
audit trail.**

It is designed to run **dark**: offline, on battery, over LoRa mesh, with no reliance
on the internet or a central server. That constraint shapes everything — including the
audit model, which must be verifiable later, by anyone holding a public key, with no
server in the loop.

Three things make Warlock distinct from "a Pi with Kali on it":

1. **One platform, three front-ends.** A web UI, a terminal UI (TUI), and an AI chat
   operator all speak to the same FastAPI backend. There is exactly one source of
   truth for state, scope, and audit.
2. **A hard engagement gate.** Offensive capability is inert until an operator arms a
   scoped *engagement*. Scope is enforced at execution time, every action is audited,
   and there is a kill switch reachable from every interface.
3. **Provable conduct.** Audit records are emitted as cryptographically signed
   attestations (Ed25519 / `did:web`) that a third party can verify offline —
   *verifying must never let you forge.*

---

## 2. Architecture — how it works

### 2.1 One backend, a module registry

The backend is a **FastAPI** app using a **module registry** pattern. Each capability
is a self-contained module under `src/warlock/modules/` that registers its routes
under `/api/{module_id}`. Adding a capability = adding a module; the registry wires it
into the API, the web UI module rail, and the TUI screen list.

```
            ┌──────────── front-ends (all TypeScript/HTTP) ────────────┐
   Web UI (React/Vite/Leaflet)   Ink TUI (terminal)   WaRL0c AI chat
            └───────────────────────┬──────────────────────────────────┘
                                     │  HTTP + WebSocket (one API)
                          ┌──────────▼───────────┐
                          │   FastAPI backend     │   Basic auth on every route
                          │   module registry     │
                          ├───────────────────────┤
                          │  engagement gate       │  scope + audit + kill switch
                          │  job runner + queues   │  crack / server-audit queues
                          │  event bus (/ws)       │  live updates to all clients
                          │  audit log → AAR       │  signed attestation records
                          └──────────┬─────────────┘
                                     │
              radios · SDR · GPS · mesh · system  (the hardware)
```

### 2.2 The engagement gate (the heart of the safety model)

- An **engagement** is an authorized test window with an explicit **scope** — the set
  of targets the operator is allowed to touch (hosts, CIDR subnets, SSIDs, BSSIDs).
- `engagement.is_on()` / `engagement.check_target(target)` are checked **at execution
  time** by every offensive operation. `ScopeAllowlist.matches()` resolves a target
  against the allowlist, including **subnet-in-CIDR** containment (an in-scope `/23`
  under a `/22` scope matches) and exact host/SSID/BSSID entries.
- Out-of-scope or no-engagement requests are **refused** and written as a
  `scope.violation` audit row (and fired to the alert bus). Accepted jobs write a
  `job.submit` row.
- **Kill switch:** `engagement.killswitch()` cancels the shared job runner **and**
  reaches into each independent module queue (`crack`, `server_audit`) so nothing
  keeps running. It restores wireless interfaces to managed mode and is reachable from
  web, TUI, and the AI agent.

### 2.3 The event bus

A WebSocket endpoint (`/ws`) fans the internal event bus to every connected client —
live engagement state, IDS alerts, job progress, SDR/ADS-B telemetry. The TUI client
authenticates the handshake with an HTTP Basic header; the browser (which can't set a
WebSocket `Authorization` header) authenticates with a short-lived signed token from
`/api/ws-token`. Auth on the bus is config-gated so a deployment can choose its
posture.

### 2.4 Audit → Agent Attestation Records (AAR)

Every audit row (scope violations, job submissions, engagement lifecycle) is, in
addition to the local chained log, emitted as a signed **Agent Attestation Record**:

- **Ed25519** asymmetric signature (no HMAC — verifying must never confer forging).
- **`did:web`** identity: the deck signs as
  `did:web:decks.techmages.org:warlock-cm5-01` under the org principal
  `did:web:techmages.org`. The deck holds its own private key (file keystore,
  `0600`), generated once.
- **JCS (RFC 8785)** canonicalization so records cross-verify exactly.
- The portable record stores `response_sha256` (a hash); the deck **retains the
  preimage** locally and serves it to an authorized party on request.
- Records carry a `prior` hash, chaining them tamper-evidently.
- A reference verifier confirms each record offline; the transparency-log host
  (`log.techmages.org`) is kept on a *separate* subdomain from identity so a
  signing-key compromise can't muddy the ledger.

This is what lets an MSP prove to a client — or an auditor, or a court — exactly what
the deck did and refused to do, without anyone having to trust the deck.

### 2.5 The front-ends

- **Web UI** — React + Vite + Leaflet (dark theme). The full operator console:
  dashboard, the guided wireless flow, SDR/ADS-B map, IDS pager, audit log, per-module
  pages. Served by the backend, behind Basic auth.
- **Ink TUI** — a terminal UI (TypeScript/React-for-CLI via Ink), 16 screens for the
  console or over SSH. Geometry-robust (adapts to the deck's 160×45 console and narrow
  SSH windows). Runs on the deck's local Node.js.
- **WaRL0c AI operator** — an on-device AI assistant (see §6), available as a standalone
  chat (`warlock chat`) and integrated, that can *guide* and *drive* an engagement
  within the gate.

---

## 3. What it can do — capabilities

The backend exposes **17 modules**. By domain:

### Wireless — recon
- **`wifi_recon`** — AP/client discovery, channel survey, handshake & PMKID capture
  (aircrack-ng suite, hcxdumptool). Drives the MediaTek MT7961 in monitor mode.

### Wireless — offense *(engagement-gated)*
- **`wifi_offensive`** — deauth, handshake/PMKID capture, **evil-twin** & **karma**
  (airbase-ng), **WPS** (reaver/bully). Every op checks scope; rogue-AP teardown is
  bounded by the kill switch.

### Wireless — defense / blue team
- **`wireless_ids`** — Kismet-based intrusion detection: rogue-AP, evil-twin, and
  deauth-flood detection, de-duplicated per capture session and published to the alert
  pager.

### Network
- **`net_recon`** — ARP scanning, port scanning (gated for non-local/wide ranges with
  audit), and a **baseline + diff** blue-team monitor that flags new hosts / changed
  MACs (ARP-spoof detection).

### Radio (SDR)
- **`sdr`** — RTL-SDR receive; **ADS-B** aircraft tracking with a rich 43-field intel
  map (registration, operator, type, signal, FMS/altitude, derived wind), live over
  the event bus.
- **`sdr_offensive`** *(gated)* — RF **capture** (record IQ), **replay** (transmit —
  **hard-gated**: requires an active engagement *and* a named in-scope target before it
  keys the radio), and **analyze** (offline signal stats). HackRF for TX; RTL-SDR for
  RX.

### Mesh / comms
- **`mesh`** — Meshtastic / LoRa SX1262 off-grid messaging.
- **`gps`** — u-blox GPS on UART with PPS time discipline.

### Audit / blue team
- **`server_audit`** — remote host hardening audits: **nmap-vuln**, **nikto**,
  **lynis**, and SSH-config review. Remote targets are engagement-gated; SSH passwords
  are passed via environment (`sshpass -e`), never argv or the audit log.

### Offline cracking
- **`crack`** — a managed **hashcat** queue. Auto-converts raw captures
  (`.cap/.pcap/.pcapng`) to hashcat's `.hc22000` format via `hcxpcapngtool`. Invisible
  to nothing — the kill switch reaches it.

### System / platform
- **`dashboard`** — at-a-glance deck health (throttle, temp, disk, radios), computed
  off the event loop so polls never stall the API.
- **`system`**, **`audio`**, **`ops`** (engagement lifecycle UI),
  **`esp32_companion`** (optional ESP32 sidekick).

---

## 4. Software on the deck

Live inventory from the running deck (Debian 13 trixie, aarch64).

### Security / wireless
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
| `sshpass` | — | non-interactive SSH for audits (env-passed) |

### Radio / SDR / mesh / time
| Package | Version | Role |
|---|---|---|
| `rtl-sdr` | 2.0.2 | RTL-SDR receive (ADS-B, scanning) |
| `hackrf` | 2024.02.1 | HackRF TX/RX (capture/replay) |
| `soapysdr-tools` | 0.8.1 | SDR abstraction |
| `readsb` | (service) | ADS-B decoder feeding `:8504/data/aircraft.json` |
| `meshtasticd` | 2.7.15 | Meshtastic / LoRa daemon |
| `gpsd` | 3.25 | GPS daemon (u-blox on `/dev/ttyAMA0`) |
| `chrony` | 4.6.1 | GPS+PPS time discipline |

*(Absent by design / pending: `eaphammer` and `urh_cli` are not installed; `airodump-ng`
ships with the aircrack-ng suite.)*

### Application stack
- **Backend (Python ≥ 3.11):** FastAPI, Uvicorn, Pydantic v2 (+ settings), SQLAlchemy,
  websockets, httpx, Rich/Textual, psutil, PyYAML, `meshtastic`, **`cryptography` ≥ 44**
  (Ed25519) and **`rfc8785`** (JCS) for signed attestation.
- **Front-end:** React + Vite + Leaflet (web); **Ink** (TypeScript) for the TUI;
  Node.js (local on the deck) for both the TUI and the AI operator.
- **AI operator:** the PI agent libraries (`@earendil-works/pi-*`) with an
  OpenAI-compatible provider (e.g. Z.AI GLM Coding Plan), configured via local env;
  keys are operator-local and never committed.

---

## 5. The hardware build (build-your-own)

Warlock is a **build-your-own** deck. This is the bill of materials and the wiring, not
a product you buy.

### 5.1 Bill of materials

| Component | Detail |
|---|---|
| **Chassis** | ClockworkPi uConsole (handheld, keyboard, LCD, battery) |
| **Compute** | Raspberry Pi **Compute Module 5**, 8 GB RAM (full CM5, eMMC) |
| **Storage** | **4 TB NVMe** (Samsung SSD 990 EVO Plus) via M.2 — the deck **boots from NVMe** |
| **Expansion** | **Hacker Gadgets AIO V2** board: RTL-SDR + LoRa **SX1262** + **GPS+PPS** + **PCF85063A RTC** + USB hub + USB 3.0 + RJ45 |
| **Wi-Fi (attack)** | **MediaTek MT7961** USB adapter — monitor mode + injection |
| **SDR (RX)** | RTL2838 (RTL-SDR) on the AIO; HackRF for TX/replay |
| **GPS** | u-blox on UART (`/dev/ttyAMA0`) with 1PPS |
| **Optional** | ESP32 companion (`esp32_companion` module) |

### 5.2 OS & boot

- **Debian 13 (trixie)**, kernel `6.12.x-v8-16k+`, aarch64.
- Boots from the **NVMe** (migrated off the eMMC for space/speed).

### 5.3 CM5 GPIO map (AIO V2 power rails)

The AIO V2 subsystems are powered by GPIO rails that must be pulled high at boot
(handled by `aiov2-*-on.service` units):

| GPIO | Subsystem | Boot state |
|---|---|---|
| 7 | SDR | high by default on CM5 |
| 27 | GPS power rail | enabled by `aiov2-gps-on.service` |
| 16 | LoRa power rail | enabled by `aiov2-lora-on.service` |
| 23 | Internal USB | enabled by `aiov2-internal-usb-on.service` |
| 6 | GPS **PPS** input | `dtoverlay=pps-gpio,gpiopin=6` |

- **RTC:** PCF85063A on I²C (internal RTC disabled in favor of it).
- **LoRa:** SX1262 on SPI1 (`spidev1.0`), driven by `meshtasticd` (region US).
- **RTL-SDR:** kernel DVB driver (`dvb_usb_rtl28xxu`) blacklisted so userspace owns the
  radio.

### 5.4 The staged build playbook

The deck is built in stages (the `ops/` playbooks document each with exact commands and
verification probes):

1. **Stage 1 — full-spectrum build-out:** AIO V2 bring-up, SDR stack, GPS+PPS+time,
   LoRa/Meshtastic, secondary Wi-Fi / wardriving kit, pentest toolkit, dev workstation,
   hardening. (`ops/01-uconsole-buildout.md`)
2. **NVMe migration:** move root to the 4 TB NVMe and boot from it.
3. **Stage 2 — Warlock Command Center:** install and run the Warlock platform itself
   (this repo) as a systemd service (`warlock.service`, `python -m warlock`).

Each subsystem has a health probe (RTC `hwclock -r`, GPS `cgps`, PPS `ppstest`, SDR
`rtl_test`, mesh `systemctl is-active meshtasticd`, Wi-Fi monitor `iw dev`), so a build
is verified, not assumed.

---

## 6. The on-device AI operator (WaRL0c)

WaRL0c is an **instructional AI assistant that runs on the deck** and can drive it —
within the gate.

- **Read tools (always available):** ~19 read-only tools wrapping the API's GET
  endpoints (deck status, engagement state, recon results, IDS alerts, captures, etc.)
  so the agent can answer questions and orient an operator.
- **Action tools (gated):** ~19 tools that POST to the **same gated endpoints the human
  uses** — arm/end an engagement, scan, capture, run offensive ops, submit cracks and
  audits, drive SDR, and **kill switch**. The agent never bypasses the gate.
- **Guided engagement setup:** the agent walks an operator through arming an engagement
  — collecting authorization and the real authorized targets, creating the engagement,
  then explaining what is now permitted — so the deck takes a newcomer "deep into" a
  proper, scoped workflow.
- **Autonomy bounds (the safety contract):** the agent operates tools autonomously
  **only inside an active engagement**; it is forbidden from arming an engagement or
  fabricating authorization on its own, it explains every action it takes, and on any
  refusal (403 / out-of-scope / no engagement) it **explains and stops** rather than
  working around the gate. RF replay additionally requires a named in-scope target. The
  read-only/gated boundary and the "no self-authorization" property are enforced by
  tests.

Provider is operator-selectable (OpenAI-compatible; e.g. Z.AI GLM Coding Plan), with
credentials held in local env on the deck — never committed.

---

## 7. Safety & ethics model (summary)

Warlock is the TechMages Charter rendered as code:

- **SAFE by default** — offense inert until a scoped engagement is armed.
- **Scope enforced at run time** — out-of-scope = refused + logged, for humans *and* the
  AI.
- **Everything audited; the kill switch reaches every queue.**
- **Records are signed and verifiable offline** (Ed25519 / JCS / `did:web`) — proof
  without trust.
- **RF emission is the strictest gate** — active engagement *plus* a named in-scope
  target.
- **The AI can't self-authorize** — it acts only inside an engagement a human armed.

Use it on systems you own or are authorized to test. Keep your scope honest. Keep your
records.

---

## 8. Repository map

| Path | What |
|---|---|
| `src/warlock/` | FastAPI backend — modules, engagement gate, job runner, event bus, auth, AAR |
| `src/warlock/modules/` | the 17 capability modules |
| `web/` | React/Vite/Leaflet web UI |
| `tui-ink/` | Ink (TypeScript) terminal UI + the WaRL0c AI operator |
| `ops/` | hardware build playbooks + field notes *(operator-local)* |
| `docs/` | this overview and other docs |

---

*Warlock OS — an open project of Titanium Computing under
[TechMages.org](https://techmages.org). Build wisely.*
