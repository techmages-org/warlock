# A0 — Module Audit + Fluke-Track (A1–A5) Sizing

> Checkpoint deliverable for the locked **Track A** contract (Fluke-grade network diagnostics).
> Date 2026-06-07. Source: local code (`src/warlock/modules/`) + live deck (`warlock`, CM5/aarch64,
> kernel 6.12.78, over the tailnet). **No build done yet — this gates A1–A5.**

## 1. Module reality (real / partial / stub)

| Module | LoC | State | Notes |
|---|---:|---|---|
| wifi_offensive | 1074 | **real** | deauth/evil-twin/karma/WPS; gated |
| ops | 962 | **real** | kill-switch, engagement ops, audit (9 TODO markers — polish, not stubs) |
| server_audit | 934 | **real** | nmap-vuln/nikto/lynis/ssh-config |
| crack | 821 | **real** | offline cracking + LOOT path |
| net_recon | 772 | **real** | nmap ARP discovery + portscan + baseline-diff + AAR emit |
| wireless_ids | 730 | **real** | rogue-AP/deauth-flood detection → ALERT bus |
| wifi_recon | 614 | **real** | monitor-mode survey, handshake/PMKID |
| sdr | 554 | **real** | RTL-SDR rx, ADS-B, rtl_433 |
| sdr_offensive | 524 | **real** | HackRF tx/replay; hard-gated |
| gps | 372 | **real** | u-blox + 1-PPS, chrony discipline |
| system | 371 | **real** | telemetry/throttle/temp |
| dashboard | 284 | **real** | HUD aggregation |
| mesh | 210 | **real** | Meshtastic/LoRa |
| audio | 195 | **real** | (1 TODO) |
| esp32_companion | 42 | **partial** | thin companion shim (3 markers) |
| _base | 30 | framework | module base |

**Conclusion:** the deck's module layer is **largely complete and real** — "the deck isn't done"
is true *at the capability level we're adding*, not because existing modules are hollow. The
**Fluke gap** is specific: there is **no LinkRunner-class wired link/cable/switch diagnostics** and
**no AirCheck-class wireless analyzer / health-report**. net_recon (discovery/portscan) and
server_audit (vuln) are adjacent but do not cover link qualification, LLDP/CDP, VLAN, DHCP/DNS/
gateway health, path-MTU, throughput-as-a-test, or a one-button PASS/FAIL.

## 2. Deck tool inventory (what A1/A3 can use today)

Installed: `ip` (iproute2) ✓ · `iperf3` ✓ · `nmap` ✓ · `nmcli` ✓ · `tcpdump` ✓ · `nping` ✓.
**Missing** (needed): `ethtool` (link speed/duplex/PHY) · `lldpd`/`lldpctl` (LLDP/CDP nearest-switch
+ port + VLAN) · `iw` (wireless scan/RSSI/roam) · `mtr` & `traceroute` (path/latency/jitter) ·
`dig` (dnsutils) · `arp-scan`. These are the exact "deck-native" tools the contract names — light,
standard apt packages, reversible. **Install needs deck sudo** (deck has `sudo -n nmap` NOPASSWD;
apt may need the sudo password).

Interfaces: `eth0` **NO-CARRIER** (no cable) · `wlan0` UP (active) · `wlan1` DOWN (2nd radio) ·
`tailscale0` UP · `docker0` DOWN.

## 3. ⛔ Blockers (operator) — surfaced per the contract tripwire

1. **No usable wired Ethernet port — RESOLVED as a HARDWARE FINDING (2026-06-07).** `eth0` is the
   CM5 on-SoC MAC (driver `macb`, `bus-info 1f00100000.ethernet`) but it has **no carrier, ever, and
   advertises only 10baseT** = a MAC with **no functional PHY/RJ45 wired to it** on this uConsole.
   Patching a cable into a switch does nothing for it (verified: carrier stays 0 after `ip link set
   eth0 up`). No USB-Ethernet adapter attached (only USB device = the RTL-SDR `0bda:2838`). `netdiag`
   *correctly* reports `carrier:false / link_detected:false` — honest, not a bug.
   → **A2 BOM item:** a **USB-Ethernet adapter (RTL8153 / AX88179-class, USB3 GbE)**. Plug it in → new
   iface (cdc_ether/r8152/ax88) → `netdiag` tests real link speed/duplex + **LLDP nearest-switch +
   port + VLAN** immediately. Until then the wired-only checks are **built + correct but unverifiable
   on this hardware**. Wlan-side checks (gateway/DHCP/DNS/ping/path-MTU/latency/jitter/iperf3) verified
   live over `wlan0`.
2. **Tool install consent.** Confirm `sudo apt install ethtool lldpd iw mtr-tiny dnsutils arp-scan`
   on the deck (contract-named tools; reversible). Proceeding under autonomy unless told otherwise.

## 4. Sized plan — A1–A5 (additive; one new `netdiag` module + a wireless analyzer)

- **A1 — `netdiag` module (LinkRunner-class), ~1 module + API + TUI/web tile.**
  - link: `ethtool eth0` / `/sys/class/net/*/speed,duplex,carrier`; CDP/LLDP: `lldpd` + `lldpctl -f json`
    (passive listen, ~30s); VLAN: lldp VLAN TLV + tagged-probe; DHCP health: `nmap --script
    broadcast-dhcp-discover` / `nping --dhcp`; DNS/gateway: resolve + ping default route; ping/TCP:
    `nping`/`nc`; path-MTU: `tracepath`/`nping --mtu`; latency/jitter/loss: `mtr --json`; throughput:
    `iperf3 -c <server>`; **one-button PASS/FAIL** roll-up with thresholds. Engagement-gate: local/
    blue-team default; non-local stays gated. **Verify on deck: wlan-side now; wired after blocker #1.**
- **A3 — wireless analyzer (AirCheck-class):** `iw dev wlan scan` / `nmcli -f ALL dev wifi`; channel/AP
  map, RSSI, utilization, roam test; surface in UI + cross-link `wireless_ids`. Verifiable on wlan0/wlan1.
- **A4 — one-button report:** HTML (+ print-to-PDF) site-survey/network-health from a netdiag+wireless
  run; structured (JSON core) so the AAR report generator (Track B) can consume it.
- **A5 — WaRL0c playbooks:** register "run wired diag", "run wireless survey", "site health report"
  as operator actions; narrate the PASS/FAIL + top findings.

**Build order:** install tools → A1 module + verify wlan-side → (cable) verify wired → A3 → A4 → A5,
each checkpointed on the real deck.

## 5. Tracks B/C/D — see [SPRINTS.md](../SPRINTS.md) (queued, back-to-back after A).
