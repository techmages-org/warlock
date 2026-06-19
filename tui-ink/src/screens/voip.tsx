// VoIP — Ink TUI screen. Module id: voip.
// RTP quality / SIP / QoS troubleshooting (Track A8): pick a capture (from the
// capture module's list) and POST /api/voip/analyze — RTP streams with
// jitter / loss / MOS (E-model), SIP message count, and the DSCP/QoS verdict
// ("is voice actually marked EF(46)?" — the #1 cause of choppy calls).
// Keys: j/k select capture, a analyze.

import { Box, Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

// ── Types (mirror src/warlock/modules/voip.py + capture.py responses) ────────

type VoipStatus = { ok: boolean; tshark: boolean; checks: string[] };

type CapItem = { id: string; bytes: number; mtime: number };

type CapList = { ok: boolean; count: number; captures: CapItem[] };

type RtpStream = {
  src: string;
  dst: string;
  ssrc: string;
  codec: string;
  packets: number;
  lost: number;
  loss_pct: number;
  mean_jitter_ms: number;
  max_jitter_ms: number;
  mos: number;
  r_factor: number;
  quality: string;
};

type Qos = {
  rtp_dscp: number | null;
  rtp_dscp_name: string | null;
  marked_ef: boolean;
  verdict: string;
  note: string;
};

type AnalyzeResp = {
  ok: boolean;
  id: string;
  rtp_streams: RtpStream[];
  stream_count: number;
  worst_mos: number | null;
  overall: string;
  qos: Qos;
  sip_messages: number;
  sip_raw: string | null;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const LIST_CAP = 7;

function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number; more: number } {
  if (items.length <= cap) return { slice: items, start: 0, more: 0 };
  const start = Math.max(0, Math.min(sel - Math.floor(cap / 2), items.length - cap));
  return { slice: items.slice(start, start + cap), start, more: items.length - start - cap };
}

function qualityColor(q: string): string {
  if (q === "excellent" || q === "good") return COLORS.mint;
  if (q === "fair") return COLORS.amber;
  if (q === "poor" || q === "bad") return COLORS.pink;
  return TEXT.dim;
}

function qosColor(v: string): string {
  if (v === "PASS") return COLORS.mint;
  if (v === "WARN") return COLORS.amber;
  if (v === "FAIL") return COLORS.pink;
  return COLORS.violet; // INFO
}

function overallLed(a: AnalyzeResp | null): LEDColor {
  if (!a) return "dim";
  if (a.overall === "no-rtp") return "dim";
  const c = qualityColor(a.overall);
  if (c === COLORS.mint) return "mint";
  if (c === COLORS.amber) return "amber";
  if (c === COLORS.pink) return "pink";
  return "dim";
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResp | null>(null);

  const { data: status, error: statusError } = usePoll<VoipStatus>(
    () => api.get<VoipStatus>("/api/voip/status"),
    5000,
    [api],
  );

  // Captures come from the capture module — voip analyzes them by id.
  const { data: list } = usePoll<CapList>(
    () => api.get<CapList>("/api/capture/list"),
    5000,
    [api],
  );

  const caps = list?.captures ?? [];
  const capsRef = useLive(caps);
  const selRef = useLive(sel);
  const busyRef = useLive(busy);

  const analyzeSelected = async () => {
    const cap = capsRef.current[Math.min(selRef.current, Math.max(0, capsRef.current.length - 1))];
    if (!cap) {
      setMsg("no capture selected — record one on the Capture screen");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<AnalyzeResp>("/api/voip/analyze", { id: cap.id });
      setAnalysis(r);
    } catch (e: unknown) {
      setMsg(`✗ analyze failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    const n = capsRef.current.length;
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === "j") setSel((s) => Math.min(Math.max(0, n - 1), s + 1));
    else if (input === "a" && !busyRef.current) void analyzeSelected();
  });

  // ── Error state ──────────────────────────────────────────────────────────
  if (statusError && !status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="15 VOIP" title="VoIP" state="LINK ERROR" icon="☏" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>voip error: {statusError}</Text>
        </Tile>
      </Box>
    );
  }

  const listW = Math.min(44, Math.max(32, Math.floor((cols - 4) / 3)));
  const rtpW = Math.min(76, cols - 4 - listW - 1);
  const selClamped = Math.min(sel, Math.max(0, caps.length - 1));
  const win = windowOf(caps, selClamped, LIST_CAP);

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="15 VOIP"
        title="VoIP"
        state={busy ? "ANALYZING" : analysis ? analysis.overall.toUpperCase() : status ? "READY" : "ACQUIRING"}
        icon="☏"
        right={
          status ? (
            <Text color={status.tshark ? COLORS.mint : COLORS.pink}>
              tshark{status.tshark ? "✓" : "✗"}
            </Text>
          ) : undefined
        }
      />

      <Box flexDirection="row" gap={1}>
        {/* Capture picker */}
        <Tile title={`CAPTURES (${caps.length})`} led={caps.length > 0 ? "cyan" : "dim"} width={listW}>
          {!list ? (
            <Text color={TEXT.dim}>loading captures…</Text>
          ) : caps.length === 0 ? (
            <Text color={TEXT.dim}>no captures — record on Capture</Text>
          ) : (
            <>
              {win.slice.map((c, i) => {
                const idx = win.start + i;
                const isSel = idx === selClamped;
                return (
                  <Box key={c.id}>
                    <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                    <Text color={isSel ? COLORS.amber : TEXT.body}>{c.id}</Text>
                  </Box>
                );
              })}
              {win.more > 0 ? <Text color={TEXT.dim}>  +{win.more} more</Text> : null}
            </>
          )}
        </Tile>

        {/* RTP quality */}
        <Tile
          title={analysis ? `RTP QUALITY — ${analysis.id}` : "RTP QUALITY"}
          led={overallLed(analysis)}
          width={rtpW}
          headerRight={
            analysis ? (
              <Text color={qualityColor(analysis.overall)} bold>
                {analysis.overall}{" "}
              </Text>
            ) : undefined
          }
        >
          {busy ? (
            <Text color={COLORS.amber}>analyzing RTP streams…</Text>
          ) : !analysis ? (
            <Text color={TEXT.dim}>select a capture and press a — MOS / jitter / loss / QoS</Text>
          ) : (
            <>
              {analysis.rtp_streams.length === 0 ? (
                <Text color={TEXT.dim}>no RTP streams found in this capture</Text>
              ) : (
                <>
                  <Box>
                    <Text color={TEXT.dim}>{"STREAM".padEnd(24)}</Text>
                    <Text color={TEXT.dim}>{"CODEC".padEnd(7)}</Text>
                    <Text color={TEXT.dim}>{"LOSS%".padEnd(6)}</Text>
                    <Text color={TEXT.dim}>{"JIT".padEnd(6)}</Text>
                    <Text color={TEXT.dim}>{"MOS".padEnd(6)}</Text>
                    <Text color={TEXT.dim}>QUALITY</Text>
                  </Box>
                  {analysis.rtp_streams.slice(0, 6).map((s) => (
                    <Box key={`${s.ssrc}-${s.src}`}>
                      <Text color={TEXT.body}>
                        {`${s.src}→${s.dst}`.slice(0, 23).padEnd(24)}
                      </Text>
                      <Text color={TEXT.dim}>{s.codec.slice(0, 6).padEnd(7)}</Text>
                      <Text color={s.loss_pct > 1 ? COLORS.pink : TEXT.body}>
                        {s.loss_pct.toFixed(1).padEnd(6)}
                      </Text>
                      <Text color={TEXT.body}>{s.mean_jitter_ms.toFixed(1).padEnd(6)}</Text>
                      <Text color={qualityColor(s.quality)} bold>
                        {s.mos.toFixed(2).padEnd(6)}
                      </Text>
                      <Text color={qualityColor(s.quality)}>{s.quality}</Text>
                    </Box>
                  ))}
                </>
              )}
              <Box>
                <Text color={TEXT.dim}>QoS </Text>
                <Text color={qosColor(analysis.qos.verdict)} bold>
                  {analysis.qos.verdict}
                </Text>
                <Text color={TEXT.dim} wrap="truncate-end">
                  {" "}{analysis.qos.note}
                </Text>
              </Box>
              <Box>
                <Text color={TEXT.dim}>SIP messages: </Text>
                <Text color={TEXT.body}>{analysis.sip_messages}</Text>
                {analysis.worst_mos != null ? (
                  <>
                    <Text color={TEXT.dim}>  worst MOS: </Text>
                    <Text color={qualityColor(analysis.overall)}>{analysis.worst_mos}</Text>
                  </>
                ) : null}
              </Box>
            </>
          )}
        </Tile>
      </Box>

      {/* Help bar */}
      <Box>
        <Text color={TEXT.dim}>a:analyze  j/k:select</Text>
        {busy ? <Text color={COLORS.amber}>  › analyzing…</Text> : null}
        {msg ? <Text color={COLORS.pink}>  {msg}</Text> : null}
      </Box>
    </Box>
  );
}
