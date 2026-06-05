// Wireless IDS — Ink TUI screen.
// Mirrors web/src/pages/Blue.tsx. Endpoints from src/warlock/modules/wireless_ids.py.
// Kismet-driven WiFi intrusion detection: rogue-AP / evil-twin / deauth floods.
// No engagement gate (requires_engagement = False — defensive / passive monitoring).
//
// Polls:
//   GET /api/wireless_ids/status     → running, iface, kismet_reachable, uptime_s, allowlist
//   GET /api/wireless_ids/detections → count, counts{rogue_ap,evil_twin,deauth_flood}, detections[]

import { Box, Text } from "ink";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

const TILE_W = 28;

// ─── Types (mirror Python response schema) ─────────────────────────────────

type WirelessIdsStatus = {
  ok: boolean;
  running: boolean;
  iface: string | null;
  channels: string | null;
  kismet_reachable: boolean;
  uptime_s: number | null;
  started_at: string | null;
  allowlist: { ssids: number; bssids: number };
};

type DetectionType = "rogue_ap" | "evil_twin" | "deauth_flood" | "kismet_alert";
type SeverityLabel = "high" | "medium" | "low" | "info";

type Detection = {
  type: DetectionType;
  severity: SeverityLabel;
  bssid: string;
  ssid: string;
  channel: number | null;
  signal: number | null;
  detail: string;
  first_seen: string | null;
  last_seen: string | null;
  source: string;
};

type DetectionResp = {
  ok: boolean;
  running: boolean;
  count: number;
  counts: {
    rogue_ap: number;
    evil_twin: number;
    deauth_flood: number;
    kismet_alert: number;
  };
  detections: Detection[];
  errors: string[];
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<DetectionType, string> = {
  rogue_ap:    "ROGUE",
  evil_twin:   "EVIL-TWIN",
  deauth_flood:"DEAUTH",
  kismet_alert:"ALERT",
};

function sevLed(sev: SeverityLabel): LEDColor {
  switch (sev) {
    case "high":   return "pink";
    case "medium": return "amber";
    case "low":    return "cyan";
    default:       return "dim";
  }
}

function fmtUptime(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// ─── Screen ────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();

  const { data: status, error: statusErr } = usePoll<WirelessIdsStatus>(
    () => api.get<WirelessIdsStatus>("/api/wireless_ids/status"),
    3000,
    [api],
  );
  const { data: det, error: detErr } = usePoll<DetectionResp>(
    () => api.get<DetectionResp>("/api/wireless_ids/detections"),
    3000,
    [api],
  );

  // Both failed and neither loaded yet → hard error
  const error = statusErr ?? detErr;
  if (error && !status && !det) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="14 BLUE-IDS" title="Wireless IDS" state="LINK ERROR" icon="🛡" />
        <Tile title="ERROR" led="pink" width={TILE_W * 2}>
          <Text color={COLORS.pink}>wireless_ids error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  // Primary data not yet available → loading
  if (!status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="14 BLUE-IDS" title="Wireless IDS" state="ACQUIRING" icon="🛡" />
        <Tile title="BOOT" led="amber" width={TILE_W}>
          <Text color={TEXT.dim}>acquiring telemetry…</Text>
        </Tile>
      </Box>
    );
  }

  const running = status.running;
  const stateLabel = running ? "MONITORING" : "IDLE";
  const highCount = (det?.counts.evil_twin ?? 0) + (det?.counts.deauth_flood ?? 0);
  const rogueCount = det?.counts.rogue_ap ?? 0;
  const detections = det?.detections ?? [];

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="14 BLUE-IDS"
        title="Wireless IDS"
        state={stateLabel}
        icon="🛡"
        right={
          <Text color={TEXT.dim}>
            {status.iface ?? "—"} · {det?.count ?? 0} detections · up {fmtUptime(status.uptime_s)}
          </Text>
        }
      />

      {/* ── Status tiles ─────────────────────────────────────────────────── */}
      <Box>
        <Tile title="STATE" led={running ? "mint" : "amber"} width={TILE_W}>
          <BigValue value={running ? "WATCH" : "IDLE"} color={running ? "mint" : "amber"} />
          <Text color={TEXT.dim}>{running ? "kismet monitor" : "passive only"}</Text>
        </Tile>

        <Tile title="KISMET" led={status.kismet_reachable ? "mint" : "dim"} width={TILE_W}>
          <BigValue
            value={status.kismet_reachable ? "UP" : "—"}
            color={status.kismet_reachable ? "mint" : "violet"}
          />
          <Text color={TEXT.dim}>REST :2501</Text>
        </Tile>

        <Tile title="THREATS" led={highCount > 0 ? "pink" : "mint"} width={TILE_W}>
          <BigValue value={highCount} color={highCount > 0 ? "pink" : "mint"} />
          <Text color={TEXT.dim}>evil-twin + deauth</Text>
        </Tile>

        <Tile title="ROGUE / UNK" led={rogueCount > 0 ? "amber" : "dim"} width={TILE_W}>
          <BigValue value={rogueCount} color="amber" />
          <Text color={TEXT.dim}>
            allow: {status.allowlist.ssids} SSID / {status.allowlist.bssids} BSSID
          </Text>
        </Tile>
      </Box>

      {/* ── Detection feed ───────────────────────────────────────────────── */}
      <Tile
        title="DETECTIONS"
        led={
          detections.some((d) => d.severity === "high")
            ? "pink"
            : detections.length
            ? "amber"
            : "mint"
        }
        width={TILE_W * 4}
      >
        {det?.errors && det.errors.length > 0 ? (
          <Text color={COLORS.amber}>kismet REST: {det.errors.join("; ")}</Text>
        ) : null}

        {detections.length === 0 ? (
          <Text color={TEXT.dim}>
            {running
              ? "monitoring active — set an SSID allowlist to flag rogues"
              : "no detections — start monitoring and set an SSID allowlist"}
          </Text>
        ) : (
          <Box flexDirection="column">
            {/* Column headers */}
            <Box>
              <Text color={TEXT.dim}>
                {"SEV   TYPE          BSSID              SSID              CH    Detail"}
              </Text>
            </Box>

            {detections.slice(0, 11).map((d, i) => (
              <Box key={`${d.type}-${d.bssid}-${i}`}>
                <StatusLED color={sevLed(d.severity)} />
                <Text color={COLORS[sevLed(d.severity)]}>
                  {` ${d.severity.slice(0, 4).toUpperCase().padEnd(5)}`}
                </Text>
                <Text color={COLORS.violet}>
                  {`${TYPE_LABEL[d.type]}`.padEnd(14)}
                </Text>
                <Text color={TEXT.body}>
                  {`${d.bssid || "—"}`.padEnd(19)}
                </Text>
                <Text color={TEXT.body}>
                  {`${d.ssid || "—"}`.slice(0, 17).padEnd(18)}
                </Text>
                <Text color={TEXT.dim}>
                  {`${d.channel ?? "?"}`.padEnd(6)}
                </Text>
                <Text color={TEXT.dim} wrap="truncate-end">
                  {d.detail}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Tile>
    </Box>
  );
}
