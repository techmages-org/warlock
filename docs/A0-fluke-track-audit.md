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

1. **Wired Ethernet — VERIFIED (2026-06-07).** `eth0` IS a real CM5 on-SoC GbE port (driver `macb`).
   The initial "no carrier / 10baseT-only" read was a **bad cable seating** — with no link the PHY
   advertises only 10baseT, which I over-read as "no PHY" (corrected). After re-seating, `eth0` is
   **1000 Mb/s Full**, took DHCP `192.168.100.84/24`, and `netdiag` verified link speed/duplex +
   **LLDP nearest-switch** (chassis `8C:86:DD:C4:A7:1C`, `port_4`) live + one-button health PASS
   (gateway 0% loss / 0.32 ms). **A1 wired is fully verified on the deck.** VLAN showed `null` (this
   switch didn't send the LLDP VLAN TLV — handled gracefully). A USB-Ethernet adapter remains an
   *optional* A2 add (a 2nd wired port / multi-segment testing), not a requirement.
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
