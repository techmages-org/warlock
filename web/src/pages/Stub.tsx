import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { StubPanel } from "../components/hud";

type StubStatus = {
  module: string;
  label: string;
  status: string;
  requires_engagement: boolean;
  todo: string[];
};

// Module metadata — codename, icon, wave number. Aligned with roadmap in
// 02-warlock-command-center.md. `todo` items come from the live API, but we
// hardcode a fallback list here so the UI still reads as "themed instrument"
// even if the backend payload is unreachable mid-boot.
type ModuleMeta = {
  codename: string;
  icon: string;
  wave: number;
  fallbackTodo: string[];
};

const MODULE_META: Record<string, ModuleMeta> = {
  sdr: {
    codename: "03 SDR-SCAN",
    icon: "∿",
    wave: 1,
    fallbackTodo: [
      "Scanner presets (FM / aviation / weather / ADS-B / ISM / POCSAG / VHF / 2m / 70cm)",
      "dump1090 ADS-B background service + aircraft table",
      "rtl_433 live decoded event feed",
      "IQ recorder to ~/warlock/captures/iq/",
    ],
  },
  wifi_recon: {
    codename: "04 WIFI-RCN",
    icon: "☰",
    wave: 1,
    fallbackTodo: [
      "Passive scan via nmcli / iw dev",
      "BSSID + SSID + RSSI + channel table",
      "Client inventory with OUI lookup",
      "Channel heatmap over time",
    ],
  },
  ops: {
    codename: "05 OPS-LOG",
    icon: "◆",
    wave: 1,
    fallbackTodo: [
      "Engagement timeline with evidence attachments",
      "Scope editor (SSIDs / BSSIDs / IP ranges)",
      "Audit log viewer",
      "Killswitch history",
    ],
  },
  net_recon: {
    codename: "06 NET-RCN",
    icon: "⚘",
    wave: 2,
    fallbackTodo: [
      "Nmap target sweeps with scope guard",
      "ARP-scan of local segment",
      "Service banners + version inference",
      "Port graph over time",
    ],
  },
  system: {
    codename: "07 SYS-CFG",
    icon: "⚙",
    wave: 2,
    fallbackTodo: [
      "Interface state + MAC randomisation",
      "Power profile (perf / balanced / battery)",
      "Storage + log rotation",
      "Update orchestration",
    ],
  },
  wifi_offensive: {
    codename: "08 WIFI-OFF",
    icon: "⚠",
    wave: 3,
    fallbackTodo: [
      "Deauth bursts (engagement-gated BSSID only)",
      "Handshake capture with aircrack-ng pipeline",
      "Evil-twin AP with hostapd",
      "Rogue-DHCP poisoning",
    ],
  },
  sdr_offensive: {
    codename: "09 SDR-OFF",
    icon: "☢",
    wave: 3,
    fallbackTodo: [
      "Replay attack harness",
      "Jamming pattern generator (scope-locked)",
      "HackRF TX chain with legal interlocks",
      "Signal synthesis console",
    ],
  },
  esp32_companion: {
    codename: "10 ESP-CMP",
    icon: "⌁",
    wave: 2,
    fallbackTodo: [
      "Serial link over UART to ESP32 companion",
      "OTA firmware push",
      "Deauther bridge (engagement-gated)",
      "Marauder command relay",
    ],
  },
};

const DEFAULT_META: ModuleMeta = {
  codename: "?? UNKNOWN",
  icon: "◌",
  wave: 0,
  fallbackTodo: [],
};

export function Stub({ moduleId }: { moduleId: string }) {
  const [s, setStatus] = useState<StubStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiGet<StubStatus>(`/api/${moduleId}/status`)
      .then((r) => { if (alive) setStatus(r); })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [moduleId]);

  const meta = MODULE_META[moduleId] ?? DEFAULT_META;
  const title = s?.label ?? moduleId;
  const todo = s?.todo && s.todo.length > 0 ? s.todo : meta.fallbackTodo;
  const requiresEngagement = s?.requires_engagement ?? false;
  const footerNote = err
    ? `status endpoint error: ${err}`
    : s
    ? `status: ${s.status}`
    : "loading module status…";

  return (
    <StubPanel
      codename={meta.codename}
      title={title}
      icon={meta.icon}
      wave={meta.wave}
      todo={todo}
      requiresEngagement={requiresEngagement}
      footerNote={footerNote}
    />
  );
}
