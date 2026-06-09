# Warlock — Complete Hardware Spec

> The full, chipset-level spec of the Warlock cyberdeck: every board, every radio,
> what it can and can't do. This is the "know exactly what's in the box" reference —
> the [README](../README.md) is the tour, [OVERVIEW §5](OVERVIEW.md) is the build
> playbook, this is the spec sheet.
>
> _Deck is a build, not a product. None of it exists without
> **[Hacker Gadgets](https://hackergadgets.com)** + **[ClockworkPi](https://www.clockworkpi.com/uconsole)**._

## What Warlock is

A **ClockworkPi uConsole** handheld, upgraded with Hacker Gadgets boards into a
battery-powered, NVMe-booting, multi-radio security workstation built around a
**Raspberry Pi Compute Module 5**. It runs **dark** — offline, on battery, over LoRa
mesh — and every offensive action is gated + cryptographically audited (see the README).

## Bill of materials

| # | Component | Source | Exact part | What it is |
|---|---|---|---|---|
| 1 | **Chassis** | ClockworkPi | uConsole | 5″ 1280×720 IPS, 47-key keyboard, mono speaker, stock LiPo |
| 2 | **Compute** | Raspberry Pi | **Compute Module 5**, 8 GB RAM, eMMC | BCM2712 quad Cortex-A76 @ 2.4 GHz (CM4 / Radxa CM5 also supported via the adapter) |
| 3 | **Upgrade kit** | Hacker Gadgets | Adapter board + NVMe-battery board + (RJ45/USB3 expansion) | CM4/CM5 adapter, **PCIe→NVMe**, **dual-18650** holder. Boots from NVMe. Expansion board = **NONE** in our config (the AIO V2 carries I/O). |
| 4 | **Storage** | source your own | any M.2 NVMe (2230–2280) | Root FS; the deck boots from it |
| 5 | **AIO V2 radio board** | Hacker Gadgets | uConsole AIO V2 | The RF hub: **RTL-SDR + LoRa + GNSS + RTC + USB 3.0 hub + 1 GbE** (details below) |
| 6 | **Attack Wi-Fi** | Hacker Gadgets | **AC1200 USB-C** (MediaTek MT7921AUN) | Wi-Fi 6/6E monitor + injection — **and Bluetooth 5.2** (often overlooked) |
| 7 | **SDR TX** | source your own | **HackRF One** | 1 MHz–6 GHz half-duplex transmit/receive (replay, Wi-Fi-band sweep) |
| 8 | **Optional** | — | ESP32 companion (Marauder) | USB-serial companion (`esp32_companion` module) |

## Radios & RF coverage — the part to actually know

Warlock carries **six independent radio surfaces** plus two Bluetooth radios. This is
the table that answers "wait, can it do X?":

| Surface | Chip | Bands / range | TX/RX | Role | Bus |
|---|---|---|---|---|---|
| **Wi-Fi (management)** | CM5 onboard **CYW43455** | 2.4 + 5 GHz, 802.11a/b/g/n/**ac** (Wi-Fi 5) | both | normal client/AP networking | SDIO (onboard) |
| **Wi-Fi (attack)** | AC1200 **MT7921AUN** | 2.4 + 5 + **6 GHz**, 802.11ax (**Wi-Fi 6/6E**) | both + **monitor & injection** | recon, deauth, evil-twin, handshake/PMKID | USB-C (AIO internal) |
| **Bluetooth #1** | CM5 **CYW43455** | 2.4 GHz | both | **BT 5.0 / BLE** — *the radio the warlock-buddy companion pairs to* | SDIO (onboard) |
| **Bluetooth #2** | AC1200 **MT7921AUN** | 2.4 GHz | both | **BT 5.2** (lower IPEX antenna pair) — spare/HID | USB-C |
| **SDR (RX)** | **RTL2832U + R860** | **100 kHz – 1.74 GHz** (HF direct-sampling 100 kHz–28.8 MHz) | RX only | ADS-B, scanning, decode, spectrum ≤1.7 GHz; TCXO; 5 V bias-tee | USB |
| **SDR (TX/RX)** | **HackRF One** | **1 MHz – 6 GHz** | half-duplex TX/RX | replay/transmit + Wi-Fi-band (2.4/5 GHz) spectrum sweep | USB |
| **LoRa / mesh** | **SX1262** | 860–960 MHz (US **902–928**), 22 dBm | both | Meshtastic off-grid comms; TCXO | SPI1 (`spidev1.0`) |
| **GNSS** | u-blox multi-mode (**GPS / BeiDou / multi-GNSS**) | L1 | RX | position + **1 PPS** time discipline; active/passive antenna | UART `/dev/ttyAMA0` + PPS GPIO6 |

**Key takeaways (the "so we know" facts):**
- **There are two Bluetooth radios** — the CM5's BT 5.0/BLE *and* the AC1200's BT 5.2. The deck can be the warlock-buddy's BLE host with **no extra hardware**; use the CM5's onboard BT and leave the AC1200 on monitor-mode duty.
- **The RTL-SDR stops at ~1.74 GHz** — Wi-Fi-band (2.4/5 GHz) spectrum needs the **HackRF**.
- **LoRa is sub-GHz only** (902–928 MHz US) — it is *not* a Wi-Fi/BT radio; it's the off-grid mesh link.
- **Monitor mode + injection lives on the AC1200 (MT7921)** — the CM5's onboard Wi-Fi is for management; keep them separate.

## Capability → which radio

| Capability | Provided by |
|---|---|
| Wi-Fi survey / wardrive / recon | AC1200 (monitor) + GNSS (geotag) |
| Wi-Fi offense (deauth, evil-twin, PMKID, WPS) — *gated* | AC1200 (injection) |
| Wi-Fi IDS (rogue-AP, deauth-flood) | AC1200 (monitor) |
| Sub-1.7 GHz spectrum / ADS-B / decode | RTL-SDR |
| 2.4/5 GHz spectrum, RF replay/transmit | HackRF |
| Off-grid messaging | LoRa SX1262 / Meshtastic |
| Position + disciplined time (PPS) | GNSS |
| Desk companion / engagement gate remote | CM5 Bluetooth (BLE) → warlock-buddy |
| Wired link / multi-segment | CM5 1 GbE + AIO RJ45 1 Gbps |

## Power, boot & interfaces

- **Power:** dual **18650** cells in the upgrade kit's NVMe-battery board (swappable, runtime-extending) + the uConsole's stock LiPo.
- **Boot:** **Debian 13 (trixie)**, kernel `6.12.x-v8-16k+`, aarch64, booting from the **NVMe** (migrated off eMMC).
- **Wired:** CM5 Gigabit Ethernet + the AIO V2 RJ45 (1 Gbps, needs the kit's adapter board). USB **3.0** hub (USB 3.0 needs upgrade kit + CM5; falls back to USB 2.0 otherwise).
- **Time:** **PCF85063A** RTC (CR1220 coin cell) + GPS **1 PPS** + `chrony` discipline.
- **AIO V2 power rails are GPIO-gated (default OFF)** — brought up at boot by `aiov2-*-on.service`:

| GPIO | Subsystem | Notes |
|---|---|---|
| 7 | SDR | high by default on CM5 |
| 27 | GPS rail | `aiov2-gps-on.service` |
| 16 | LoRa rail | `aiov2-lora-on.service` |
| 23 | Internal USB | `aiov2-internal-usb-on.service` |
| 6 | GPS **PPS** in | `dtoverlay=pps-gpio,gpiopin=6` |

Driver notes: RTL-SDR kernel DVB driver (`dvb_usb_rtl28xxu`) is **blacklisted** so userspace owns the radio; LoRa SX1262 on `spidev1.0` driven by `meshtasticd` (region US); RTC replaces the disabled internal one.

## ⚠️ Verify-on-deck / known gaps
- **AC1200 chip ID:** current Hacker Gadgets spec is **MT7921AUN** (Wi-Fi 6/6E + BT 5.2); some earlier units shipped as **MT7961** (also Wi-Fi 6 + BT 5.2). Confirm yours with `lsusb` / `lsusb -t`. Either way: monitor-mode Wi-Fi **and** Bluetooth are present.
- **Cable TDR / PoE measurement:** not in the base build — the CM5 GbE PHY (`macb`) doesn't expose `ethtool --cable-test`; PoE needs an inline I2C sensor. See [docs/A2-hardware-spec.md](A2-hardware-spec.md) for the drop-in BOM.
- **AIO V2 standalone:** RTL-SDR/LoRa/GPS/RTC work without the adapter board, but the **RJ45 won't**, and USB drops to 2.0.

## Credits
The deck is only possible because of **[Hacker Gadgets](https://hackergadgets.com)** (Upgrade Kit, AIO V2, AC1200) and the **[ClockworkPi uConsole](https://www.clockworkpi.com/uconsole)**. SDR/LoRa/GNSS/Bluetooth chipset facts sourced from the Hacker Gadgets product pages and the Raspberry Pi CM5 datasheet.
