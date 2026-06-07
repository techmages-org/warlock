// System — Ink TUI screen.
// Mirrors web/src/pages/System.tsx.
// Always-visible status strip (CPU / temp / memory / disk / uptime).
// Four tabs: [1] HW (AIO GPIO rails)  [2] SVC (systemd services)
//            [3] NET (network ifaces)  [4] LOG (journalctl tail)
// Keys: 1-4 switch tabs, j/k move cursor, o toggle AIO rail or service.

import { Box, Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

// ── Types ────────────────────────────────────────────────────────────────────

type SysStatus = {
  ok: boolean;
  hostname: string;
  uptime_s: number;
  cpu_percent: number;
  load_avg: number[];
  temp_c: number | null;
  memory: { total_mb: number; available_mb: number; percent: number };
  disk_root: { free_mb: number; total_mb: number; percent: number };
};

type AioRail = {
  gpio: number;
  available: boolean;
  level?: number;
  label?: string | null;
};

type AioStatus = {
  ok: boolean;
  rails: Record<string, AioRail>;
};

type ServiceRow = {
  unit: string;
  activestate: string;
  substate: string;
  enabled: string;
};

type ServicesStatus = {
  ok: boolean;
  services: ServiceRow[];
};

type NetIface = {
  name: string;
  type: string;
  up: boolean;
  ipv4: string | null;
  ipv6: string | null;
  mac: string;
  speed: number | null;
  ssid?: string;
  signal?: number;
};

type NetworkStatus = {
  ok: boolean;
  interfaces: NetIface[];
};

type JournalStatus = {
  ok: boolean;
  lines: string[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function railLed(rail: AioRail): LEDColor {
  if (!rail.available) return "dim";
  return rail.level === 1 ? "mint" : "amber";
}

function svcLed(svc: ServiceRow): LEDColor {
  if (svc.activestate === "active") return "mint";
  if (svc.activestate === "activating") return "amber";
  if (svc.activestate === "failed") return "pink";
  return "dim";
}

function netLed(iface: NetIface): LEDColor {
  return iface.up ? "mint" : "dim";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

// ── Screen ───────────────────────────────────────────────────────────────────

type Tab = "hw" | "svc" | "net" | "log";

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const tileW = Math.min((stdout?.columns ?? 120) - 2, 116);
  const [tab, setTab] = useState<Tab>("hw");
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: status, error: statusError } = usePoll<SysStatus>(
    () => api.get<SysStatus>("/api/system/status"),
    2000,
    [api],
  );

  const { data: aioData } = usePoll<AioStatus>(
    () => api.get<AioStatus>("/api/system/aio"),
    5000,
    [api, tick],
  );

  const { data: svcData } = usePoll<ServicesStatus>(
    () => api.get<ServicesStatus>("/api/system/services"),
    5000,
    [api, tick],
  );

  const { data: netData } = usePoll<NetworkStatus>(
    () => api.get<NetworkStatus>("/api/system/network"),
    5000,
    [api],
  );

  const { data: logData } = usePoll<JournalStatus>(
    () => api.get<JournalStatus>("/api/system/journal?lines=50"),
    3000,
    [api],
  );

  // Derived lists for cursor navigation
  const hwRails: [string, AioRail][] = aioData ? Object.entries(aioData.rails) : [];
  const svcList: ServiceRow[] = svcData?.services ?? [];
  const netList: NetIface[] = netData?.interfaces ?? [];
  const logLines: string[] = logData?.lines ?? [];

  // Live refs — prevent stale closure in useInput
  const tabRef = useLive(tab);
  const cursorRef = useLive(cursor);
  const hwRailsRef = useLive(hwRails);
  const svcListRef = useLive(svcList);
  const netListRef = useLive(netList);
  const logLinesRef = useLive(logLines);

  useInput((input, key) => {
    const curTab = tabRef.current;

    // Tab switching (1-4)
    if (input === "1") { setTab("hw"); setCursor(0); setMsg(null); return; }
    if (input === "2") { setTab("svc"); setCursor(0); setMsg(null); return; }
    if (input === "3") { setTab("net"); setCursor(0); setMsg(null); return; }
    if (input === "4") { setTab("log"); setCursor(0); setMsg(null); return; }

    // Cursor movement
    const listLen =
      curTab === "hw" ? hwRailsRef.current.length :
      curTab === "svc" ? svcListRef.current.length :
      curTab === "net" ? netListRef.current.length :
      logLinesRef.current.length;

    if (key.upArrow || input === "k") {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor(c => Math.min(Math.max(0, listLen - 1), c + 1));
      return;
    }

    // Actions — derive selHw/selSvc inside handler from refs
    if (input === "o") {
      const cur = cursorRef.current;
      if (curTab === "hw") {
        const selHw = hwRailsRef.current[cur];
        if (selHw) {
          const [railName, rail] = selHw;
          const action = rail.level === 1 ? "off" : "on";
          void api
            .post(`/api/system/aio/${railName}/${action}`)
            .then(() => { setTick(t => t + 1); setMsg(`${railName} → ${action.toUpperCase()}`); })
            .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
        }
      } else if (curTab === "svc") {
        const selSvc = svcListRef.current[cur];
        if (selSvc) {
          const action = selSvc.activestate === "active" ? "stop" : "start";
          void api
            .post(`/api/system/services/${selSvc.unit}/${action}`)
            .then(() => { setTick(t => t + 1); setMsg(`${selSvc.unit} → ${action}`); })
            .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    }
  });

  // ── Error state ─────────────────────────────────────────────────────────────
  if (statusError) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="10 SYS" title="System" state="LINK ERROR" icon="◈" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>system error: {statusError}</Text>
        </Tile>
      </Box>
    );
  }

  // ── Status strip ─────────────────────────────────────────────────────────────
  const cpuColor: LEDColor =
    (status?.cpu_percent ?? 0) > 90 ? "pink" :
    (status?.cpu_percent ?? 0) > 70 ? "amber" : "mint";
  const tempColor: LEDColor =
    (status?.temp_c ?? 0) > 80 ? "pink" :
    (status?.temp_c ?? 0) > 65 ? "amber" : "mint";
  const memColor: LEDColor =
    (status?.memory.percent ?? 0) > 90 ? "pink" :
    (status?.memory.percent ?? 0) > 80 ? "amber" : "mint";

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="10 SYS"
        title="System"
        state={status ? "NOMINAL" : "ACQUIRING"}
        icon="◈"
        right={status ? <Text color={TEXT.dim}>{status.hostname}</Text> : undefined}
      />

      {/* Always-visible status strip */}
      <Box>
        <Text color={TEXT.dim}> CPU:</Text>
        <Text color={COLORS[cpuColor]}>{status ? `${status.cpu_percent.toFixed(0)}%` : "—"}</Text>
        <Text color={TEXT.dim}>  TEMP:</Text>
        <Text color={COLORS[tempColor]}>{status?.temp_c != null ? `${status.temp_c.toFixed(0)}°C` : "—"}</Text>
        <Text color={TEXT.dim}>  MEM:</Text>
        <Text color={COLORS[memColor]}>{status ? `${status.memory.percent.toFixed(0)}%` : "—"}</Text>
        <Text color={TEXT.dim}>  DISK:</Text>
        <Text color={COLORS.amber}>{status ? `${status.disk_root.percent.toFixed(0)}%` : "—"}</Text>
        <Text color={TEXT.dim}>  UP:</Text>
        <Text color={COLORS.violet}>{status ? fmtUptime(status.uptime_s) : "—"}</Text>
      </Box>

      {/* Tab bar */}
      <Box>
        {(["hw", "svc", "net", "log"] as Tab[]).map((t, i) => (
          <Text key={t} color={tab === t ? COLORS.amber : TEXT.dim} bold={tab === t}>
            {i > 0 ? "  │  " : " "}[{i + 1}]{" "}
            {t === "hw" ? "HARDWARE" : t === "svc" ? "SERVICES" : t === "net" ? "NETWORK" : "LOG"}
          </Text>
        ))}
      </Box>

      {/* Tab content */}
      {tab === "hw" && (
        <Tile title="AIO / GPIO RAILS" led={aioData ? "mint" : "dim"} width={tileW}>
          {!aioData ? (
            <Text color={TEXT.dim}>loading rails…</Text>
          ) : hwRails.length === 0 ? (
            <Text color={TEXT.dim}>no rails found</Text>
          ) : (
            hwRails.map(([name, rail], i) => {
              const isSel = i === cursor;
              const led = railLed(rail);
              const state = !rail.available ? "N/A" : rail.level === 1 ? "ON" : "OFF";
              return (
                <Box key={name}>
                  <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                  <Text color={isSel ? COLORS.amber : TEXT.body}>{name.padEnd(14)}</Text>
                  <Text color={TEXT.dim}>GPIO{String(rail.gpio).padStart(2)}  </Text>
                  <StatusLED color={led} />
                  <Text color={COLORS[led]}> {state.padEnd(4)}</Text>
                  {rail.label ? <Text color={TEXT.dim}> {rail.label}</Text> : null}
                </Box>
              );
            })
          )}
        </Tile>
      )}

      {tab === "svc" && (
        <Tile title="SYSTEMD SERVICES" led={svcData ? "mint" : "dim"} width={tileW}>
          {!svcData ? (
            <Text color={TEXT.dim}>loading services…</Text>
          ) : svcList.length === 0 ? (
            <Text color={TEXT.dim}>no services</Text>
          ) : (
            svcList.map((svc, i) => {
              const isSel = i === cursor;
              const led = svcLed(svc);
              return (
                <Box key={svc.unit}>
                  <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                  <Text color={isSel ? COLORS.amber : TEXT.body} wrap="truncate-end">
                    {svc.unit.padEnd(32)}
                  </Text>
                  <StatusLED color={led} />
                  <Text color={COLORS[led]}>
                    {" "}{svc.activestate.padEnd(11)}
                  </Text>
                  <Text color={TEXT.dim}>{svc.substate.padEnd(9)}</Text>
                  <Text color={TEXT.dim}>{svc.enabled}</Text>
                </Box>
              );
            })
          )}
        </Tile>
      )}

      {tab === "net" && (
        <Tile title="NETWORK INTERFACES" led={netData ? "mint" : "dim"} width={tileW}>
          {!netData ? (
            <Text color={TEXT.dim}>loading interfaces…</Text>
          ) : netList.length === 0 ? (
            <Text color={TEXT.dim}>no interfaces</Text>
          ) : (
            netList.map((iface, i) => {
              const isSel = i === cursor;
              const led = netLed(iface);
              return (
                <Box key={iface.name}>
                  <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                  <StatusLED color={led} />
                  <Text color={isSel ? COLORS.amber : TEXT.body}>
                    {" "}{iface.name.padEnd(10)}
                  </Text>
                  <Text color={TEXT.dim}>{iface.up ? "UP  " : "DOWN"}</Text>
                  <Text color={TEXT.body}>
                    {(iface.ipv4 ?? "—").padEnd(18)}
                  </Text>
                  {iface.ssid ? (
                    <Text color={COLORS.cyan}>{iface.ssid.slice(0, 24)}</Text>
                  ) : (
                    <Text color={TEXT.dim}>{iface.type}</Text>
                  )}
                  {iface.signal != null ? (
                    <Text color={TEXT.dim}>  {iface.signal}dBm</Text>
                  ) : null}
                </Box>
              );
            })
          )}
        </Tile>
      )}

      {tab === "log" && (
        <Tile title="JOURNAL TAIL" led={logData ? "mint" : "dim"} width={tileW}>
          {!logData ? (
            <Text color={TEXT.dim}>loading journal…</Text>
          ) : logLines.length === 0 ? (
            <Text color={TEXT.dim}>no log entries</Text>
          ) : (
            logLines.slice(-18).map((line, i) => (
              <Text key={i} color={TEXT.dim} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Tile>
      )}

      {/* Help / action bar */}
      <Box>
        <Text color={TEXT.dim}>
          1-4:tab  j/k:move
          {(tab === "hw" || tab === "svc") ? "  o:toggle" : ""}
        </Text>
        {msg ? <Text color={COLORS.amber}>  › {msg}</Text> : null}
      </Box>
    </Box>
  );
}
