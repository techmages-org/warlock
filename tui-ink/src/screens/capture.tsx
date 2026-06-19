// Capture — Ink TUI screen. Module id: capture.
// Packet capture & expert analysis ("the shark", Track A7):
//   s → POST /api/capture/start (bounded 10s capture on the default iface)
//   a → POST /api/capture/analyze on the selected capture
//   list from GET /api/capture/list, j/k to select; download path shown.
// Captures are own-segment but always audited server-side (chain of custody).

import { Box, Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT } from "../lib/theme.js";

// ── Types (mirror src/warlock/modules/capture.py responses) ──────────────────

type CapStatus = { ok: boolean; tshark: boolean; dumpcap: boolean; captures: number };

type CapItem = { id: string; bytes: number; mtime: number };

type CapList = { ok: boolean; count: number; captures: CapItem[] };

type StartResp = {
  ok: boolean;
  id: string;
  iface: string;
  filter: string | null;
  seconds: number;
  packets: number | null;
  bytes: number;
};

type ExpertFinding = { finding: string; count: number };

type Talker = { a: string; b: string; frames: number; bytes: number };

type AnalyzeResp = {
  ok: boolean;
  id: string;
  expert: ExpertFinding[];
  top_talkers: Talker[];
  protocol_hierarchy: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const LIST_CAP = 8;
const CAPTURE_SECS = 10;

function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number; more: number } {
  if (items.length <= cap) return { slice: items, start: 0, more: 0 };
  const start = Math.max(0, Math.min(sel - Math.floor(cap / 2), items.length - cap));
  return { slice: items.slice(start, start + cap), start, more: items.length - start - cap };
}

function fmtBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)}M`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)}K`;
  return `${b}B`;
}

function fmtMtime(mtime: number): string {
  return new Date(mtime * 1000).toISOString().slice(5, 16).replace("T", " ");
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
  const cols = stdout?.columns ?? 120;

  const [sel, setSel] = useState(0);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResp | null>(null);

  const { data: status, error: statusError } = usePoll<CapStatus>(
    () => api.get<CapStatus>("/api/capture/status"),
    5000,
    [api, tick],
  );

  const { data: list } = usePoll<CapList>(
    () => api.get<CapList>("/api/capture/list"),
    4000,
    [api, tick],
  );

  const caps = list?.captures ?? [];
  const capsRef = useLive(caps);
  const selRef = useLive(sel);
  const busyRef = useLive(busy);

  const startCapture = async () => {
    setBusy(`capturing ${CAPTURE_SECS}s`);
    setMsg(null);
    try {
      const r = await api.post<StartResp>("/api/capture/start", { seconds: CAPTURE_SECS });
      setMsg(`✓ ${r.id} — ${r.packets ?? "?"} pkts, ${fmtBytes(r.bytes)} on ${r.iface}`);
      setTick((t) => t + 1);
      setSel(0);
    } catch (e: unknown) {
      setMsg(`✗ capture failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const analyzeSelected = async () => {
    const cap = capsRef.current[Math.min(selRef.current, Math.max(0, capsRef.current.length - 1))];
    if (!cap) {
      setMsg("no capture selected — press s to record one");
      return;
    }
    setBusy(`analyzing ${cap.id}`);
    setMsg(null);
    try {
      const r = await api.post<AnalyzeResp>("/api/capture/analyze", { id: cap.id });
      setAnalysis(r);
    } catch (e: unknown) {
      setMsg(`✗ analyze failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  };

  useInput((input, key) => {
    const n = capsRef.current.length;
    if (key.upArrow || input === "k") {
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSel((s) => Math.min(Math.max(0, n - 1), s + 1));
      return;
    }
    if (busyRef.current) return;
    if (input === "s") void startCapture();
    else if (input === "a") void analyzeSelected();
  });

  // ── Error state ──────────────────────────────────────────────────────────
  if (statusError && !status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="14 CAP" title="Capture" state="LINK ERROR" icon="◫" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>capture error: {statusError}</Text>
        </Tile>
      </Box>
    );
  }

  const listW = Math.min(46, Math.max(34, Math.floor((cols - 4) / 2)));
  const anaW = Math.min(70, cols - 4 - listW - 1);
  const selClamped = Math.min(sel, Math.max(0, caps.length - 1));
  const win = windowOf(caps, selClamped, LIST_CAP);
  const selected = caps[selClamped];

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="14 CAP"
        title="Capture"
        state={busy ? busy.toUpperCase() : status ? "READY" : "ACQUIRING"}
        icon="◫"
        right={
          status ? (
            <Text color={status.tshark ? COLORS.mint : COLORS.pink}>
              tshark{status.tshark ? "✓" : "✗"}
            </Text>
          ) : undefined
        }
      />

      <Box flexDirection="row" gap={1}>
        {/* Capture list */}
        <Tile title={`CAPTURES (${caps.length})`} led={caps.length > 0 ? "cyan" : "dim"} width={listW}>
          {!list ? (
            <Text color={TEXT.dim}>loading captures…</Text>
          ) : caps.length === 0 ? (
            <Text color={TEXT.dim}>no captures — press s to record</Text>
          ) : (
            <>
              {win.slice.map((c, i) => {
                const idx = win.start + i;
                const isSel = idx === selClamped;
                return (
                  <Box key={c.id}>
                    <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                    <Text color={isSel ? COLORS.amber : TEXT.body}>{c.id.padEnd(22)}</Text>
                    <Text color={TEXT.dim}>{fmtBytes(c.bytes).padStart(6)} {fmtMtime(c.mtime)}</Text>
                  </Box>
                );
              })}
              {win.more > 0 ? <Text color={TEXT.dim}>  +{win.more} more</Text> : null}
            </>
          )}
        </Tile>

        {/* Analysis */}
        <Tile
          title={analysis ? `ANALYSIS — ${analysis.id}` : "ANALYSIS"}
          led={analysis ? "violet" : "dim"}
          width={anaW}
        >
          {busy?.startsWith("analyzing") ? (
            <Text color={COLORS.amber}>{busy}…</Text>
          ) : !analysis ? (
            <Text color={TEXT.dim}>select a capture and press a for expert analysis</Text>
          ) : (
            <>
              <Text color={TEXT.dim}>EXPERT FINDINGS</Text>
              {analysis.expert.length === 0 ? (
                <Text color={TEXT.dim}>  none</Text>
              ) : (
                analysis.expert.slice(0, 5).map((f) => (
                  <Box key={f.finding}>
                    <Text color={COLORS.amber}>{String(f.count).padStart(5)}× </Text>
                    <Text color={TEXT.body} wrap="truncate-end">
                      {f.finding}
                    </Text>
                  </Box>
                ))
              )}
              <Text color={TEXT.dim}>TOP TALKERS</Text>
              {analysis.top_talkers.length === 0 ? (
                <Text color={TEXT.dim}>  none</Text>
              ) : (
                analysis.top_talkers.slice(0, 5).map((t) => (
                  <Box key={`${t.a}-${t.b}`}>
                    <Text color={COLORS.cyan}>{t.a}</Text>
                    <Text color={TEXT.dim}> ⇄ </Text>
                    <Text color={COLORS.cyan}>{t.b}</Text>
                    <Text color={TEXT.dim}>
                      {"  "}{t.frames} frames  {fmtBytes(t.bytes)}
                    </Text>
                  </Box>
                ))
              )}
            </>
          )}
        </Tile>
      </Box>

      {/* Selected capture download path (Wireshark-ready .pcap) */}
      {selected ? (
        <Text color={TEXT.dim} wrap="truncate-end">
          {" "}DL: {api.baseUrl}/api/capture/download/{selected.id}
        </Text>
      ) : null}

      {/* Help bar */}
      <Box>
        <Text color={TEXT.dim}>s:capture({CAPTURE_SECS}s)  a:analyze  j/k:select</Text>
        {busy ? <Text color={COLORS.amber}>  › {busy}…</Text> : null}
        {msg ? <Text color={msg.startsWith("✓") ? COLORS.mint : COLORS.pink}>  {msg}</Text> : null}
      </Box>
    </Box>
  );
}
