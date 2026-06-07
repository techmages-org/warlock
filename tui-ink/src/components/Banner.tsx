// ============================================================================
// Banner + Capabilities — the warlock-chat launch splash. Reusable components
// (the deck TUI reuses them in W2). Rendered ONCE as <Static> items so they go
// to scrollback and scroll away as the conversation grows.
// ============================================================================

import { Box, Text } from "ink";
import { READ_ENDPOINTS } from "../lib/agent.js";
import { COLORS, TEXT } from "../lib/theme.js";

// WARLOCK in ANSI-Shadow block art (≤72 cols so it never wraps on a uConsole).
const ART = [
  "██╗    ██╗ █████╗ ██████╗ ██╗      ██████╗  ██████╗██╗  ██╗",
  "██║    ██║██╔══██╗██╔══██╗██║     ██╔═══██╗██╔════╝██║ ██╔╝",
  "██║ █╗ ██║███████║██████╔╝██║     ██║   ██║██║     █████╔╝ ",
  "██║███╗██║██╔══██║██╔══██╗██║     ██║   ██║██║     ██╔═██╗ ",
  "╚███╔███╔╝██║  ██║██║  ██║███████╗╚██████╔╝╚██████╗██║  ██╗",
  " ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝",
];

export function Banner() {
  return (
    <Box flexDirection="column">
      {ART.map((line, i) => (
        <Text key={i} color={COLORS.violet}>
          {line}
        </Text>
      ))}
      <Text color={COLORS.cyan}>✦ cyberdeck assistant · read-only · grounded in live deck state</Text>
    </Box>
  );
}

// Capability groups → labels. Names reference lib/agent.ts READ_ENDPOINTS so the
// welcome stays in sync with the actual tool set; anything new (or ungrouped)
// falls into the "Other" catch-all rather than silently vanishing.
const GROUPS: { title: string; names: string[] }[] = [
  { title: "Deck status", names: ["dashboard_status", "system_status", "modules_list"] },
  { title: "Engagement", names: ["engagement_status", "active_engagement"] },
  { title: "Wi-Fi", names: ["wifi_recon_status", "wifi_access_points", "wifi_clients", "wireless_ids_status", "crack_status"] },
  { title: "Network", names: ["net_recon_status", "net_recon_hosts", "server_audit_status"] },
  { title: "Radio / SDR", names: ["sdr_status", "sdr_presets", "adsb_aircraft", "rtl433_events"] },
  { title: "Mesh / GPS", names: ["mesh_nodes", "gps_fix"] },
];

const TITLE_W = 13;

export function Capabilities() {
  const byName = new Map(READ_ENDPOINTS.map((e) => [e.name, e.label] as const));
  const used = new Set<string>();
  const groups = GROUPS.map((g) => ({
    title: g.title,
    labels: g.names
      .filter((n) => byName.has(n))
      .map((n) => {
        used.add(n);
        return byName.get(n)!;
      }),
  })).filter((g) => g.labels.length > 0);
  const other = READ_ENDPOINTS.filter((e) => !used.has(e.name)).map((e) => e.label);

  return (
    <Box flexDirection="column">
      <Text color={COLORS.cyan}>I read this deck's live state (read-only) — ask me anything:</Text>
      {groups.map((g) => (
        <Text key={g.title}>
          {"  "}
          <Text color={COLORS.violet}>{g.title.padEnd(TITLE_W)}</Text>
          <Text color={TEXT.dim}>{g.labels.join(", ")}</Text>
        </Text>
      ))}
      {other.length ? (
        <Text>
          {"  "}
          <Text color={COLORS.violet}>{"Other".padEnd(TITLE_W)}</Text>
          <Text color={TEXT.dim}>{other.join(", ")}</Text>
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={TEXT.dim}>I guide; you act. Deck screens: </Text>
        <Text color={COLORS.mint}>g d</Text>
        <Text color={TEXT.dim}> dash · </Text>
        <Text color={COLORS.mint}>g f</Text>
        <Text color={TEXT.dim}> wireless · </Text>
        <Text color={COLORS.mint}>g e</Text>
        <Text color={TEXT.dim}> ops · </Text>
        <Text color={COLORS.mint}>g c</Text>
        <Text color={TEXT.dim}> crack</Text>
      </Box>
    </Box>
  );
}
