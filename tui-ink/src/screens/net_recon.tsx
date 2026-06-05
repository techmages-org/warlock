// Net Recon — Ink TUI screen.
// Mirrors web/src/pages/NetRecon.tsx. Endpoints from src/warlock/modules/net_recon.py.
// LAN host discovery + nmap port scans + blue-team baseline/diff monitoring.
//
// Engagement gate: POST /portscan is gated for non-RFC1918 targets or CIDR < /24.
// Defensive monitoring (ARP sweep / baseline / diff / alerts) is always allowed.
//
// Polls:
//   GET /api/net_recon/status           → subnet, gateway, hosts_seen, last_scan, profiles
//   GET /api/net_recon/hosts?limit=100  → hosts[]
//   GET /api/net_recon/alerts           → defense diff alerts from last run

import { Box, Text, useStdout } from "ink";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

const TILE_W = 28;

// ─── Types ─────────────────────────────────────────────────────────────────

type NetReconStatus = {
  ok: boolean;
  subnet: string | null;
  gateway: string | null;
  hosts_seen: number;
  last_scan: {
    id: string;
    target: string;
    profile: string;
    status: string;
    hosts_found: number;
  } | null;
  profiles: string[];
};

type Port = { port: number; proto: string; state: string; service: string };

type Host = {
  ip: string;
  mac: string;
  vendor: string;
  hostname: string;
  ports: Port[];
  os_guess: string;
  first_seen: string | null;
  last_seen: string | null;
};

type HostsResp = {
  ok: boolean;
  hosts: Host[];
  count: number;
};

type AlertSeverity = "info" | "warning" | "critical";

type DefenseAlert = {
  type: "new_host" | "gone_host" | "new_service" | "gone_service" | "mac_changed";
  severity: AlertSeverity;
  ip: string;
  mac?: string;
  old_mac?: string;
  vendor?: string;
  hostname?: string;
  port?: number;
  proto?: string;
  service?: string;
  message: string;
};

type AlertSummary = {
  new_host: number;
  gone_host: number;
  new_service: number;
  gone_service: number;
  mac_changed: number;
  total: number;
};

type AlertsResp = {
  ok: boolean;
  alerts: DefenseAlert[];
  summary: AlertSummary;
  generated_at: string | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function alertLed(sev: AlertSeverity): LEDColor {
  switch (sev) {
    case "critical": return "pink";
    case "warning":  return "amber";
    default:         return "violet";
  }
}

function scanStatusLed(s: string | undefined): LEDColor {
  if (s === "success") return "mint";
  if (s === "running") return "cyan";
  if (s === "failed")  return "pink";
  return "amber";
}

// ─── Screen ────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();

  // Geometry: body budget after subtracting measured app-shell chrome.
  // chrome@120×24=8 rows, chrome@160×45=7 rows — use 8 as conservative constant.
  const termRows = (stdout.rows as number | undefined) ?? 24;
  const bodyBudget = Math.max(8, termRows - 8);

  const { data: status, error: statusErr } = usePoll<NetReconStatus>(
    () => api.get<NetReconStatus>("/api/net_recon/status"),
    3000,
    [api],
  );
  const { data: hostsResp } = usePoll<HostsResp>(
    () => api.get<HostsResp>("/api/net_recon/hosts?limit=100"),
    3000,
    [api],
  );
  const { data: alertsResp } = usePoll<AlertsResp>(
    () => api.get<AlertsResp>("/api/net_recon/alerts"),
    5000,
    [api],
  );

  if (statusErr && !status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="07 NET-REC" title="Net Recon" state="LINK ERROR" icon="⚘" />
        <Tile title="ERROR" led="pink" width={TILE_W * 2}>
          <Text color={COLORS.pink}>net_recon error: {statusErr}</Text>
        </Tile>
      </Box>
    );
  }

  if (!status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="07 NET-REC" title="Net Recon" state="ACQUIRING" icon="⚘" />
        <Tile title="BOOT" led="amber" width={TILE_W}>
          <Text color={TEXT.dim}>acquiring telemetry…</Text>
        </Tile>
      </Box>
    );
  }

  const hosts = hostsResp?.hosts ?? [];
  const alerts = alertsResp?.alerts ?? [];
  const summary = alertsResp?.summary;
  const lastScan = status.last_scan;

  // ── Dynamic list caps ─────────────────────────────────────────────────────
  // The two-column HOSTS/DEFENSE row must fit within (bodyBudget - 7).
  //   7 = ModuleHeader(1) + gate note(1) + summary tiles row(5)
  // Both tiles run alongside each other — their heights must independently
  // be ≤ rowBudget so the taller one doesn't blow the budget.
  //
  // HOSTS tile overhead   = 4 (top border + title row + col-label + bottom border)
  // DEFENSE tile overhead = 7 (top border + title row + 4 summary rows + bottom border)
  //                          + 1 if timestamp is present
  const ROW_BUDGET = bodyBudget - 7;
  // HOSTS
  const HOSTS_OVERHEAD = 4;
  const maxHostRows = Math.max(1, ROW_BUDGET - HOSTS_OVERHEAD);
  const hasMoreHosts = hosts.length > maxHostRows;
  // When capped, last slot becomes the "+N more" indicator
  const displayHosts = hasMoreHosts
    ? hosts.slice(0, maxHostRows - 1)
    : hosts.slice(0, maxHostRows);
  const hiddenHosts = hosts.length - displayHosts.length;
  // DEFENSE ALERTS
  const hasTimestamp = !!(alertsResp?.generated_at);
  const DEFENSE_OVERHEAD = 7 + (hasTimestamp ? 1 : 0);
  const maxAlerts = Math.max(0, ROW_BUDGET - DEFENSE_OVERHEAD);

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="07 NET-REC"
        title="Net Recon"
        state="READY"
        icon="⚘"
        right={
          <Text color={TEXT.dim}>
            {status.subnet ?? "—"} · {status.hosts_seen} hosts · gw {status.gateway ?? "—"}
          </Text>
        }
      />

      {/* Engagement gate note — port scan of non-RFC1918 / wide CIDR requires engagement */}
      <Box>
        <Text color={COLORS.pink}>! </Text>
        <Text color={TEXT.dim}>
          Port scan of non-RFC1918 or CIDR &lt;/24 requires engagement — ARP sweep / defense is always allowed
        </Text>
      </Box>

      {/* ── Summary tiles ────────────────────────────────────────────────── */}
      <Box>
        <Tile title="SUBNET" led="violet" width={TILE_W}>
          <BigValue value={status.subnet ?? "—"} color="violet" />
        </Tile>

        <Tile
          title="HOSTS SEEN"
          led={status.hosts_seen > 0 ? "mint" : "amber"}
          width={TILE_W}
        >
          <BigValue value={status.hosts_seen} color="cyan" />
          <Text color={TEXT.dim}>cumulative</Text>
        </Tile>

        <Tile title="GATEWAY" led="amber" width={TILE_W}>
          <BigValue value={status.gateway ?? "—"} color="amber" />
        </Tile>

        <Tile
          title="LAST SCAN"
          led={scanStatusLed(lastScan?.status)}
          width={TILE_W}
        >
          <BigValue value={lastScan?.profile ?? "—"} color="mint" />
          <Text color={TEXT.dim}>
            {lastScan?.status ?? "—"} · {lastScan?.hosts_found ?? 0} up
          </Text>
        </Tile>
      </Box>

      {/* ── Hosts table + defense alerts ─────────────────────────────────── */}
      <Box>
        {/* Hosts — wide left column */}
        <Tile
          title="HOSTS"
          led={hosts.length > 0 ? "mint" : "amber"}
          width={TILE_W * 3}
        >
          {hosts.length === 0 ? (
            <Text color={TEXT.dim}>no hosts yet — run an ARP sweep</Text>
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text color={TEXT.dim}>
                  {"IP               MAC               Vendor       Hostname     Ports"}
                </Text>
              </Box>
              {displayHosts.map((h) => (
                <Box key={h.ip}>
                  <Text color={COLORS.violet}>{h.ip.padEnd(17)}</Text>
                  <Text color={TEXT.body}>
                    {(h.mac || "—").padEnd(18)}
                  </Text>
                  <Text color={TEXT.body}>
                    {(h.vendor || "—").slice(0, 12).padEnd(13)}
                  </Text>
                  <Text color={COLORS.amber}>
                    {(h.hostname || "—").slice(0, 12).padEnd(13)}
                  </Text>
                  <Text color={COLORS.cyan} wrap="truncate-end">
                    {h.ports.slice(0, 6).map((p) => `${p.port}/${p.proto}`).join(" ") || "—"}
                  </Text>
                </Box>
              ))}
              {hiddenHosts > 0 && (
                <Text color={TEXT.dim}>+{hiddenHosts} more hosts…</Text>
              )}
            </Box>
          )}
        </Tile>

        {/* Defense alerts — narrow right column */}
        <Tile
          title="DEFENSE ALERTS"
          led={
            alerts.some((a) => a.severity === "critical")
              ? "pink"
              : alerts.length
              ? "amber"
              : "mint"
          }
          width={TILE_W}
        >
          {summary ? (
            <Box flexDirection="column">
              <Box>
                <Text color={COLORS.pink} bold>{summary.mac_changed} </Text>
                <Text color={TEXT.dim}>mac-change</Text>
              </Box>
              <Box>
                <Text color={COLORS.amber} bold>{summary.new_host} </Text>
                <Text color={TEXT.dim}>new host</Text>
              </Box>
              <Box>
                <Text color={COLORS.amber} bold>{summary.new_service} </Text>
                <Text color={TEXT.dim}>new svc</Text>
              </Box>
              <Box>
                <Text color={TEXT.dim}>{summary.gone_host} gone host</Text>
              </Box>
              {alertsResp?.generated_at ? (
                <Text color={TEXT.dim}>
                  @ {(alertsResp.generated_at).slice(11, 19)}
                </Text>
              ) : null}
            </Box>
          ) : (
            <Text color={TEXT.dim}>no diff run</Text>
          )}

          {/* Alert messages — capped so DEFENSE tile fits within rowBudget */}
          {alerts.slice(0, maxAlerts).map((a, i) => (
            <Box key={`${a.type}-${a.ip}-${i}`} width={TILE_W - 4}>
              <StatusLED color={alertLed(a.severity)} />
              <Text color={TEXT.dim} wrap="truncate-end">
                {" "}{a.message}
              </Text>
            </Box>
          ))}
        </Tile>
      </Box>
    </Box>
  );
}
