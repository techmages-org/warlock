// Net Diag — Ink TUI screen. Module id: netdiag.
// Fluke/LinkRunner-class one-button link & path qualification.
// Centerpiece: the VERDICT table — per-check PASS/WARN/FAIL + detail from
// POST /api/netdiag/health, augmented by errors / flap / ntp / wan checks.
// Keys: r=run diagnostics  d=dhcp scan (slow)  t=iperf3 throughput prompt.
// iperf to a NON-local (non-RFC1918) server is engagement-gated (!) — the 403
// detail from the backend is surfaced verbatim, never bypassed.

import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

// ── Types (mirror src/warlock/modules/netdiag.py responses) ──────────────────

type NdStatus = {
  ok: boolean;
  gateway: string | null;
  iface: string | null;
  tools: Record<string, boolean>;
  checks: string[];
};

type CheckRow = { check: string; verdict: string; detail: string };

type HealthResp = {
  ok: boolean;
  iface: string;
  verdict: { overall: string; checks: CheckRow[] };
};

type ErrorsResp = {
  ok: boolean;
  iface: string;
  verdict: string;
  notes: string[];
};

type FlapResp = { ok: boolean; iface: string; verdict: string; note: string };

type VerdictNote = { ok: boolean; available?: boolean; verdict?: string; note?: string };

type DhcpScanResp = { ok: boolean; iface: string; verdict?: string; note?: string };

type ThroughputResp = {
  ok: boolean;
  throughput: {
    available: boolean;
    ok?: boolean;
    server?: string;
    down_mbps?: number;
    up_mbps?: number;
    note?: string;
  };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const ORDER: Record<string, number> = { FAIL: 2, WARN: 1, PASS: 0 };

function worst(rows: CheckRow[]): string {
  let out = "PASS";
  for (const r of rows) {
    if ((ORDER[r.verdict] ?? 0) > (ORDER[out] ?? 0)) out = r.verdict;
  }
  return out;
}

function verdictColor(v: string): string {
  if (v === "PASS") return COLORS.mint;
  if (v === "WARN") return COLORS.amber;
  if (v === "FAIL") return COLORS.pink;
  return TEXT.dim;
}

function verdictLed(v: string | null): LEDColor {
  if (v === "PASS") return "mint";
  if (v === "WARN") return "amber";
  if (v === "FAIL") return "pink";
  return "dim";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

// ── Screen ───────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const tileW = Math.min((stdout?.columns ?? 120) - 2, 116);

  const [rows, setRows] = useState<CheckRow[]>([]);
  const [overall, setOverall] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [iperfOpen, setIperfOpen] = useState(false);
  const [iperfServer, setIperfServer] = useState("");

  const { data: status, error: statusError } = usePoll<NdStatus>(
    () => api.get<NdStatus>("/api/netdiag/status"),
    5000,
    [api],
  );

  const statusRef = useLive(status);
  const runningRef = useLive(running);
  const iperfOpenRef = useLive(iperfOpen);
  const iperfServerRef = useLive(iperfServer);

  // Upsert one check row (replace by name or append), recompute overall.
  const upsert = (acc: CheckRow[], row: CheckRow): CheckRow[] => {
    const next = [...acc.filter((r) => r.check !== row.check), row];
    setRows(next);
    setOverall(worst(next));
    return next;
  };

  const runAll = async () => {
    setRunning("health");
    let acc: CheckRow[] = [];
    setRows([]);
    setOverall(null);
    try {
      const h = await api.post<HealthResp>("/api/netdiag/health", {});
      acc = [...h.verdict.checks];
      setRows(acc);
      setOverall(worst(acc));
    } catch (e: unknown) {
      acc = upsert(acc, { check: "health", verdict: "FAIL", detail: errMsg(e) });
    }
    setRunning("ethtool");
    try {
      const er = await api.post<ErrorsResp>("/api/netdiag/errors", {});
      acc = upsert(acc, {
        check: "ethtool",
        verdict: er.verdict,
        detail: er.notes[0] ?? "no interface errors",
      });
    } catch (e: unknown) {
      acc = upsert(acc, { check: "ethtool", verdict: "WARN", detail: errMsg(e) });
    }
    setRunning("flaps");
    try {
      const fl = await api.post<FlapResp>("/api/netdiag/flap", {});
      acc = upsert(acc, { check: "flaps", verdict: fl.verdict, detail: fl.note });
    } catch (e: unknown) {
      acc = upsert(acc, { check: "flaps", verdict: "WARN", detail: errMsg(e) });
    }
    setRunning("ntp");
    try {
      const ntp = await api.post<VerdictNote>("/api/netdiag/ntp", {});
      acc = upsert(acc, {
        check: "ntp",
        verdict: ntp.verdict ?? "WARN",
        detail: ntp.note ?? "chronyc unavailable",
      });
    } catch (e: unknown) {
      acc = upsert(acc, { check: "ntp", verdict: "WARN", detail: errMsg(e) });
    }
    setRunning("wan");
    try {
      const wan = await api.post<VerdictNote>("/api/netdiag/wan", {});
      acc = upsert(acc, {
        check: "wan",
        verdict: wan.verdict ?? "WARN",
        detail: wan.note ?? "no WAN check",
      });
    } catch (e: unknown) {
      acc = upsert(acc, { check: "wan", verdict: "WARN", detail: errMsg(e) });
    }
    setRunning(null);
  };

  const runDhcp = async () => {
    setRunning("dhcp_scan");
    try {
      const d = await api.post<DhcpScanResp>("/api/netdiag/dhcp_scan", {});
      upsert(rows, {
        check: "dhcp_scan",
        verdict: d.verdict ?? "WARN",
        detail: d.note ?? "no DHCP offer seen",
      });
    } catch (e: unknown) {
      upsert(rows, { check: "dhcp_scan", verdict: "WARN", detail: errMsg(e) });
    }
    setRunning(null);
  };

  const runIperf = async (server: string) => {
    const target = server.trim();
    if (!target) return;
    setRunning("iperf");
    try {
      const t = await api.post<ThroughputResp>("/api/netdiag/throughput", { server: target });
      const tp = t.throughput;
      upsert(rows, {
        check: "iperf",
        verdict: !tp.available ? "WARN" : tp.ok ? "PASS" : "WARN",
        detail: !tp.available
          ? "iperf3 not installed"
          : tp.ok
            ? `↓${tp.down_mbps} Mbps  ↑${tp.up_mbps} Mbps  (${target})`
            : (tp.note ?? "iperf failed"),
      });
    } catch (e: unknown) {
      // 403 = engagement gate — surface the backend detail verbatim, marked "!".
      upsert(rows, { check: "iperf", verdict: "FAIL", detail: `! ${errMsg(e)}` });
    }
    setRunning(null);
  };

  useInput((input, key) => {
    if (iperfOpenRef.current) {
      // Prompt mode: the screen owns Enter/Esc; TextInput owns plain chars.
      if (key.escape) {
        setIperfOpen(false);
        return;
      }
      if (key.return) {
        setIperfOpen(false);
        void runIperf(iperfServerRef.current);
      }
      return;
    }
    if (runningRef.current) return;
    if (input === "r") void runAll();
    else if (input === "d") void runDhcp();
    else if (input === "t") {
      setIperfServer(statusRef.current?.gateway ?? "");
      setIperfOpen(true);
    }
  });

  // ── Error state ──────────────────────────────────────────────────────────
  if (statusError && !status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="12 DIAG" title="Net Diag" state="LINK ERROR" icon="⌁" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>netdiag error: {statusError}</Text>
        </Tile>
      </Box>
    );
  }

  const tools = status?.tools ?? {};
  const headerState = running
    ? `RUNNING ${running.toUpperCase()}`
    : (overall ?? (status ? "READY" : "ACQUIRING"));

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="12 DIAG"
        title="Net Diag"
        state={headerState}
        icon="⌁"
        right={status ? <Text color={TEXT.dim}>{status.iface ?? "no iface"}</Text> : undefined}
      />

      {/* Status strip — primary iface / gateway / tool availability */}
      <Box>
        <Text color={TEXT.dim}> IFACE:</Text>
        <Text color={COLORS.cyan}>{status?.iface ?? "—"}</Text>
        <Text color={TEXT.dim}>  GW:</Text>
        <Text color={COLORS.violet}>{status?.gateway ?? "—"}</Text>
        <Text color={TEXT.dim}>  TOOLS: </Text>
        {Object.entries(tools).map(([name, ok]) => (
          <Text key={name} color={ok ? COLORS.mint : TEXT.dim}>
            {name}{ok ? "✓" : "✗"}{" "}
          </Text>
        ))}
      </Box>

      {/* Verdict table — the centerpiece */}
      <Tile
        title="VERDICT"
        led={verdictLed(overall)}
        width={tileW}
        headerRight={
          overall ? (
            <Text color={verdictColor(overall)} bold>
              {overall}{" "}
            </Text>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <Text color={TEXT.dim}>
            {running ? `running ${running}…` : "press r to run diagnostics"}
          </Text>
        ) : (
          rows.map((r) => (
            <Box key={r.check}>
              <Text color={TEXT.body}>{r.check.padEnd(11)}</Text>
              <Text color={verdictColor(r.verdict)} bold>
                {r.verdict.padEnd(6)}
              </Text>
              <Text color={TEXT.dim} wrap="truncate-end">
                {r.detail}
              </Text>
            </Box>
          ))
        )}
        {running && rows.length > 0 ? (
          <Text color={COLORS.amber}>… {running} running</Text>
        ) : null}
      </Tile>

      {/* iperf prompt */}
      {iperfOpen ? (
        <Tile title="IPERF3 SERVER" led="violet" width={tileW}>
          <Box>
            <Text color={TEXT.dim}>server: </Text>
            <TextInput value={iperfServer} onChange={setIperfServer} placeholder="host or ip" />
          </Box>
          <Text color={TEXT.dim}>↵ run  esc cancel  ! non-local servers are engagement-gated</Text>
        </Tile>
      ) : null}

      {/* Help bar */}
      <Box>
        <Text color={TEXT.dim}>r:run diag  d:dhcp scan  t:iperf(!)</Text>
        {running ? <Text color={COLORS.amber}>  › {running}…</Text> : null}
      </Box>
    </Box>
  );
}
