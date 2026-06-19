// Net Tools — Ink TUI screen. Module id: nettools.
// Field utility pack (Track A11): subnet calculator, OUI vendor lookup,
// Wake-on-LAN, TLS/cert inspector, internet speedtest.
// Keys: ←/→ switch tool, type the argument, ↵ run. (Plain chars belong to the
// input — tool switching is arrows-only, same convention as the mesh screen.)

import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT } from "../lib/theme.js";

// ── Types (mirror src/warlock/modules/nettools.py responses) ─────────────────

type NtStatus = { ok: boolean; oui_entries: number; curl: boolean; checks: string[] };

type ToolResult = Record<string, unknown>;

type ToolDef = {
  key: string;
  label: string;
  path: string;
  placeholder: string;
  needsInput: boolean;
  body: (value: string) => Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
  {
    key: "subnet",
    label: "SUBNET",
    path: "/api/nettools/subnet",
    placeholder: "CIDR e.g. 192.168.1.0/24",
    needsInput: true,
    body: (v) => ({ cidr: v }),
  },
  {
    key: "oui",
    label: "OUI",
    path: "/api/nettools/oui",
    placeholder: "MAC e.g. a4:83:e7:12:34:56",
    needsInput: true,
    body: (v) => ({ mac: v }),
  },
  {
    key: "wol",
    label: "WOL",
    path: "/api/nettools/wol",
    placeholder: "MAC to wake",
    needsInput: true,
    body: (v) => ({ mac: v }),
  },
  {
    key: "tls",
    label: "TLS",
    path: "/api/nettools/tls",
    placeholder: "host[:port]",
    needsInput: true,
    body: (v) => {
      const [host, port] = v.split(":");
      return port ? { host, port: Number(port) } : { host };
    },
  },
  {
    key: "speedtest",
    label: "SPEED",
    path: "/api/nettools/speedtest",
    placeholder: "↵ to run (no input)",
    needsInput: false,
    body: () => ({}),
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtValue(v: unknown): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function valueColor(key: string, v: unknown): string {
  if (key === "verdict") {
    if (v === "PASS") return COLORS.mint;
    if (v === "WARN") return COLORS.amber;
    if (v === "FAIL") return COLORS.pink;
  }
  return TEXT.hi;
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
  const tileW = Math.min((stdout?.columns ?? 120) - 2, 100);

  const [toolIdx, setToolIdx] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({ subnet: "192.168.1.0/24" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tool: string; data: ToolResult } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: status, error: statusError } = usePoll<NtStatus>(
    () => api.get<NtStatus>("/api/nettools/status"),
    10000,
    [api],
  );

  const tool = TOOLS[toolIdx]!;
  const value = values[tool.key] ?? "";

  const toolIdxRef = useLive(toolIdx);
  const valuesRef = useLive(values);
  const busyRef = useLive(busy);

  const run = async () => {
    const t = TOOLS[toolIdxRef.current]!;
    const v = (valuesRef.current[t.key] ?? "").trim();
    if (t.needsInput && !v) {
      setMsg(`enter ${t.placeholder}`);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const data = await api.post<ToolResult>(t.path, t.body(v));
      setResult({ tool: t.label, data });
    } catch (e: unknown) {
      setMsg(`✗ ${t.label.toLowerCase()}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  useInput((_input, key) => {
    // ←/→ switch tool; Enter runs; plain chars belong to the TextInput.
    if (key.leftArrow) setToolIdx((i) => (i + TOOLS.length - 1) % TOOLS.length);
    else if (key.rightArrow) setToolIdx((i) => (i + 1) % TOOLS.length);
    else if (key.return && !busyRef.current) void run();
  });

  // ── Error state ──────────────────────────────────────────────────────────
  if (statusError && !status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="16 TOOLS" title="Net Tools" state="LINK ERROR" icon="✛" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>nettools error: {statusError}</Text>
        </Tile>
      </Box>
    );
  }

  const entries = result ? Object.entries(result.data).filter(([k]) => k !== "ok") : [];

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="16 TOOLS"
        title="Net Tools"
        state={busy ? "RUNNING" : status ? "READY" : "ACQUIRING"}
        icon="✛"
        right={
          status ? (
            <Text color={TEXT.dim}>
              OUI db {status.oui_entries}  curl{status.curl ? "✓" : "✗"}
            </Text>
          ) : undefined
        }
      />

      {/* Tool selector */}
      <Box>
        {TOOLS.map((t, i) => (
          <Text key={t.key} color={i === toolIdx ? COLORS.amber : TEXT.dim} bold={i === toolIdx}>
            {i > 0 ? "  │  " : " "}{i === toolIdx ? "▸" : " "}{t.label}
          </Text>
        ))}
      </Box>

      {/* Input row */}
      <Box>
        <Text color={TEXT.dim}> {tool.label.toLowerCase()} › </Text>
        {tool.needsInput ? (
          <TextInput
            key={tool.key}
            value={value}
            onChange={(v) => setValues((prev) => ({ ...prev, [tool.key]: v }))}
            placeholder={tool.placeholder}
          />
        ) : (
          <Text color={TEXT.dim}>{tool.placeholder}</Text>
        )}
      </Box>

      {/* Result */}
      <Tile
        title={result ? `RESULT — ${result.tool}` : "RESULT"}
        led={busy ? "amber" : result ? "mint" : "dim"}
        width={tileW}
      >
        {busy ? (
          <Text color={COLORS.amber}>running {tool.label.toLowerCase()}…</Text>
        ) : !result ? (
          <Text color={TEXT.dim}>←/→ pick a tool, type the argument, ↵ to run</Text>
        ) : entries.length === 0 ? (
          <Text color={TEXT.dim}>empty result</Text>
        ) : (
          entries.slice(0, 14).map(([k, v]) => (
            <Box key={k}>
              <Text color={TEXT.dim}>{k.padEnd(20)}</Text>
              <Text color={valueColor(k, v)} wrap="truncate-end">
                {fmtValue(v)}
              </Text>
            </Box>
          ))
        )}
      </Tile>

      {/* Help bar */}
      <Box>
        <Text color={TEXT.dim}>←/→:tool  ↵:run</Text>
        {busy ? <Text color={COLORS.amber}>  › running…</Text> : null}
        {msg ? <Text color={COLORS.pink}>  {msg}</Text> : null}
      </Box>
    </Box>
  );
}
