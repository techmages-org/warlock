# A2 — Hardware Peripheral Spec + Software Hooks (Track A)

> Per the locked contract, A2 is **spec only — BOM + software hooks, no measurement code**. Validated
> against the live deck (CM5/uConsole) 2026-06-07. The point: name the exact part, how it attaches,
> and the module endpoint that would drive it — so each is a drop-in when the hardware lands.

## Deck capability check (what's already possible vs. needs hardware)

| Feature | Deck check | Verdict |
|---|---|---|
| Cable TDR / wiremap | `ethtool --cable-test eth0` → **"PHY driver does not support cable testing"** | **needs hardware** |
| PoE voltage/class | `/dev/i2c-1,3,6,10…` present | **small HW add — I2C sensor** |
| RF spectrum (sub-1.7 GHz) | RTL-SDR (RTL2838) + `rtl_power` present | **software now** (no BOM) |
| RF spectrum (2.4/5 GHz Wi-Fi) | only RTL-SDR (≤1.7 GHz); no HackRF | **needs hardware** |
| 2nd wired port / multi-segment | no spare RJ45 | **optional USB-GbE** |

## A2.1 — Cable wiremap + TDR (fault distance)
- **Why HW:** the CM5 GbE PHY (driver `macb`) does **not** expose `ethtool --cable-test`, so there is
  no software path to open/short/split-pair detection or fault-distance (TDR).
- **BOM:** a dedicated cable-test front end — e.g. a **Microchip LAN867x / a PHY that supports IEEE
  cable diagnostics on a USB-GbE adapter** (some RTL8156/AX88179 variants expose `ethtool
  --cable-test`), or a standalone **wiremap remote + tester** read over USB/serial. Cheapest path:
  pick a USB-GbE NIC whose PHY supports cable-test, then TDR becomes software on *that* iface.
- **SW hook:** `POST /api/netdiag/cable {iface}` → `ethtool --cable-test <iface>` →
  per-pair `{status: ok|open|short|impedance-mismatch, fault_distance_m}`. (Verify the chosen NIC's
  PHY reports cable-test before committing the BOM.)

## A2.2 — PoE detect / class / voltage
- **Why HW:** measuring PoE voltage/current needs a sensor in the power path; software alone can't.
  **The deck has I2C** (`/dev/i2c-*`), so this is a small add, not a new subsystem.
- **BOM:** an **INA219 / INA260** I2C current+voltage breakout on the PoE pair pass-through, plus a
  **PoE tap / RJ45 splitter** so the deck sits inline. (~$10 of parts.) Detects 802.3af/at/bt by
  the negotiated voltage/power envelope.
- **SW hook:** `POST /api/netdiag/poe {bus, addr}` → read INA260 over `/dev/i2c-N` →
  `{voltage_v, current_ma, power_w, class: "af|at|bt|none"}`. Local/blue-team, no gate.

## A2.3 — RF spectrum analyzer
- **Software NOW (no BOM):** the existing **RTL-SDR + `rtl_power`** covers ~24 MHz–1.7 GHz → a
  `POST /api/sdr/spectrum {start_mhz,end_mhz,bin_khz}` endpoint (rtl_power sweep → FFT bins →
  channel power / interference floor) handles ISM 433/868/915 MHz, cellular, etc.
- **Why HW (Wi-Fi bands):** the RTL-SDR can't reach 2.4/5 GHz, so Wi-Fi-band spectrum/interference
  needs **a HackRF One** (1 MHz–6 GHz, drives `hackrf_sweep` — already-installed tooling) **or** a
  **MetaGeek Wi-Spy DBx / RF Explorer** USB analyzer.
- **SW hook:** the same `/api/sdr/spectrum` endpoint switches backend by band — `rtl_power` (≤1.7 GHz)
  or `hackrf_sweep` (Wi-Fi). Feeds the A3 channel-utilization view + A6 walk-test (RF-interference overlay).

## A2.4 — USB-Ethernet adapter (optional, from the A1 finding)
- The uConsole's built-in RJ45 (eth0) is the only wired port. A **USB3 GbE adapter (RTL8153 /
  AX88179)** adds a 2nd wired interface for **multi-segment testing** (one port on the client LAN, one
  on a trunk/uplink) — and, if its PHY supports cable-test, also unlocks A2.1 TDR in software.
- **SW hook:** none needed — `netdiag` auto-detects the new iface; every wired check (link/LLDP/
  errors/flap/health) already accepts an `iface` param. Plug-and-test.

## Summary
- **Software-achievable today (no BOM, future modules):** sub-1.7 GHz RF spectrum (RTL-SDR + rtl_power).
- **Small I2C add:** PoE measurement (INA260 + PoE tap).
- **Genuine peripherals:** cable-TDR front end (or a cable-test-capable USB-GbE NIC), Wi-Fi-band
  spectrum (HackRF / Wi-Spy), optional 2nd-port USB-GbE.
- No measurement code written (per the contract). Each endpoint above is a drop-in when the part lands.
