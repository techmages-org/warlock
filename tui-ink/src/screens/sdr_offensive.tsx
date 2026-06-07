// ============================================================================
// OFFENSIVE SDR (sdr_offensive) — RF capture · analyze · replay console.
// Engagement-GATED. Rebuilt for the Phase-3 backend (be-p3) whose
// GET /api/sdr_offensive/status now returns the rich operational shape:
//   { ok, module, label, requires_engagement, engaged, engagement,
//     tools:{hackrf,rtl_sdr,urh→{path,present}}, tx_capable, ops, captures:[
//       {id,filename,path,freq_mhz,sample_rate,duration_s,size_bytes,
//        created_at,modulation} ] }
//
// Actions (POST — be-p3 FROZEN contract; freq in MHz; the backend gate authorizes each):
//   capture  /api/sdr_offensive/capture { freq_mhz, sample_rate, duration_s, target? }
//            — RX (radio auto-selected), ENGAGEMENT-GATED (403 without an active engagement).
//   analyze  /api/sdr_offensive/analyze { capture }  — passive, always allowed.
//   replay   /api/sdr_offensive/replay  { capture, freq_mhz, sample_rate,
//            tx_gain, target } — RF-EMITTING, HARD-gated AND a
//            two-key confirm-before-transmit (press r → edit target → Enter to
//            CONFIRM TRANSMIT; Esc cancels). The required in-scope `target` is
//            prefilled from the active engagement scope.
//
// Geometry: reads the live terminal (useStdout); list scrolls in a fitted
// window; mode panels (capture/replay) REPLACE the list so height stays bounded.
// Mirrors the web SdrOffensive page (web/src/pages/SdrOffensive.tsx) field-for-
// field. NO stub — every action hits a real endpoint.
// ============================================================================

import { Box, Text, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import type { EngagementStatus } from "../lib/types.js";
import { COLORS, TEXT } from "../lib/theme.js";

const APP_CHROME = 8;
const FREQ_MHZ_MIN = 0.01; // 10 kHz
const FREQ_MHZ_MAX = 7_250; // 7.25 GHz
const DEFAULT_SR = 2_000_000;
const DASH = "—";

type Capture = {
  id?: string | null;
  filename?: string | null;
  path?: string | null;
  freq_mhz?: number | null;
  freq_hz?: number | null;
  sample_rate?: number | null;
  duration_s?: number | null;
  size_bytes?: number | null;
  created_at?: string | null;
  modulation?: string | null;
};

type OpResult = {
  ok?: boolean;
  op?: string | null;
  detail?: string | null;
  audit_id?: string | null;
  error?: string | null;
  ts?: string | number | null;
  job_id?: string | null;
} | null;

// be-p3's FROZEN v2 status shape. All fields optional → degrade to "—" exactly
// like the web page, so the screen renders whatever the backend serves.
type SdrOffStatus = {
  ok?: boolean;
  rx_device?: string | null;
  tx_device?: string | null;
  tx_capable?: boolean | null;
  busy?: boolean | null;
  reason?: string | null;
  captures?: Capture[];
  last_result?: OpResult;
  requires_engagement?: boolean;
  engaged?: boolean;
};

type Mode = "list" | "capture" | "replay";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function useViewport() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 24;
  return { cols, rows, body: Math.max(6, rows - APP_CHROME) };
}
function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number; more: number } {
  if (cap <= 0 || items.length <= cap) return { slice: items, start: 0, more: Math.max(0, items.length - Math.max(0, cap)) };
  const start = clamp(sel - Math.floor(cap / 2), 0, items.length - cap);
  return { slice: items.slice(start, start + cap), start, more: items.length - cap };
}
function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

function capFile(c: Capture): string {
  return c.filename || c.id || c.path || "";
}
function capLabel(c: Capture): string {
  return c.filename || c.id || c.path || "capture";
}
function capMhz(c: Capture): number | undefined {
  if (c.freq_mhz != null && Number.isFinite(c.freq_mhz)) return c.freq_mhz;
  if (c.freq_hz != null && Number.isFinite(c.freq_hz)) return c.freq_hz / 1e6;
  return undefined;
}
function fmtMhz(c: Capture): string {
  const mhz = c.freq_mhz ?? (c.freq_hz != null ? c.freq_hz / 1e6 : null);
  return mhz != null && Number.isFinite(mhz) ? `${mhz.toFixed(3)}M` : DASH;
}
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return DASH;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}
function scopeEntriesOf(eng: EngagementStatus | null): string[] {
  const s = eng?.scope;
  if (!s) return [];
  return [...(s.ssids ?? []), ...(s.bssids ?? []), ...(s.ip_ranges ?? [])]
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);
}

export function Screen() {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { cols, body } = useViewport();

  const { data: s, error } = usePoll<SdrOffStatus>(
    () => api.get<SdrOffStatus>("/api/sdr_offensive/status"),
    5000,
    [api],
  );
  const { data: eng } = usePoll<EngagementStatus>(
    () => api.get<EngagementStatus>("/api/engagements/active"),
    2000,
    [api],
  );

  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // capture form
  const [freqMhz, setFreqMhz] = useState("433.92");
  const [durationS, setDurationS] = useState("5");
  const [capField, setCapField] = useState(0); // 0 = freq, 1 = duration

  // replay confirm — opens DEFOCUSED on the y/f confirm state; `t` focuses the
  // target field for editing (so confirm-state keystrokes hit the screen
  // useInput, not the TextInput → no pollution / no reflexive-Enter footgun).
  const [replayTarget, setReplayTarget] = useState("");
  const [replayEditing, setReplayEditing] = useState(false);

  const captures: Capture[] = s?.captures ?? [];
  const engMode = eng?.mode;
  const engaged = engMode === "on";
  const txCapable = s?.tx_capable === true;
  const serverBusy = s?.busy === true;

  const capturesRef = useLive(captures);
  const cursorRef = useLive(cursor);
  const engagedRef = useLive(engaged);
  const busyRef = useLive(busy);
  const modeRef = useLive(mode);
  const freqMhzRef = useLive(freqMhz);
  const durationSRef = useLive(durationS);
  const replayTargetRef = useLive(replayTarget);
  const replayEditingRef = useLive(replayEditing);

  const explain403 = (op: string) =>
    engagedRef.current
      ? `${op} refused (403) — target not in engagement scope. Add it on Operations (g e).`
      : `${op} refused (403) — no active engagement. Arm one on Operations (g e).`;

  const post = async (op: string, path: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setNote(`${op}…`);
    try {
      const d = await api.post<{ ok?: boolean; op?: string; detail?: string; audit_id?: string; error?: string; job_id?: string }>(path, payload);
      const ok = d?.ok !== false;
      const msg = d?.detail || (ok ? "ok" : d?.error || "failed");
      const aud = d?.audit_id ? ` · audit ${String(d.audit_id).slice(0, 8)}` : "";
      setNote(`${op}: ${msg}${aud}`);
    } catch (e) {
      const m = String(e);
      setNote(m.includes("403") ? explain403(op) : `${op} failed: ${m}`);
    } finally {
      setBusy(false);
    }
  };

  const fireCapture = () => {
    const mhz = Number(freqMhzRef.current);
    const dur = Number(durationSRef.current);
    if (!Number.isFinite(mhz) || mhz <= 0) { setNote("capture: enter a valid frequency in MHz"); return; }
    if (mhz < FREQ_MHZ_MIN || mhz > FREQ_MHZ_MAX) { setNote("capture: frequency out of range (0.01 – 7250 MHz)"); return; }
    if (!Number.isFinite(dur) || dur < 1 || dur > 300) { setNote("capture: duration must be 1–300 s"); return; }
    setMode("list");
    void post("capture", "/api/sdr_offensive/capture", { freq_mhz: mhz, sample_rate: DEFAULT_SR, duration_s: Math.round(dur) });
  };

  const fireReplay = () => {
    const cap = capturesRef.current[clamp(cursorRef.current, 0, Math.max(0, capturesRef.current.length - 1))];
    const target = replayTargetRef.current.trim();
    if (!cap) { setNote("replay: select a capture first"); setMode("list"); return; }
    if (!engagedRef.current) { setNote("! replay gated — engagement no longer active"); setMode("list"); return; }
    if (!target) { setNote("replay: an in-scope target is REQUIRED to authorize the RF emission — press t to enter one"); return; }
    setMode("list");
    setReplayEditing(false);
    void post("replay", "/api/sdr_offensive/replay", {
      capture: capFile(cap),
      freq_mhz: capMhz(cap),
      sample_rate: cap.sample_rate ?? DEFAULT_SR,
      tx_gain: 0,
      target,
    });
  };

  const analyzeSelected = () => {
    const cap = capturesRef.current[clamp(cursorRef.current, 0, Math.max(0, capturesRef.current.length - 1))];
    if (!cap) { setNote("analyze: no captures yet — record IQ first (press c)"); return; }
    void post("analyze", "/api/sdr_offensive/analyze", { capture: capFile(cap) });
  };

  const openReplay = () => {
    const cap = capturesRef.current[clamp(cursorRef.current, 0, Math.max(0, capturesRef.current.length - 1))];
    if (!cap) { setNote("replay: no captures yet — record IQ first (press c)"); return; }
    if (!engagedRef.current) { setNote("! replay is RF-EMITTING and engagement-gated — arm an engagement first (g e)"); return; }
    setReplayTarget(scopeEntriesOf(eng)[0] ?? "");
    setReplayEditing(false); // open on the y/f confirm state, field defocused
    setNote(null);
    setMode("replay");
  };

  useInput(
    (input, key) => {
      // capture / replay modes: the screen owns Esc + Enter (the "confirm" key);
      // the focused TextInput owns plain-char editing via onChange. Handling
      // Enter here (not via TextInput.onSubmit) makes the two-key fire
      // deterministic and ref-backed (no useInput staleness).
      if (modeRef.current === "capture") {
        if (key.escape) { setMode("list"); setNote(null); }
        else if (key.upArrow) setCapField(0);
        else if (key.downArrow) setCapField(1);
        else if (key.return) fireCapture();
        return;
      }
      if (modeRef.current === "replay") {
        // EDIT sub-mode: the target TextInput is focused; the screen only catches
        // Enter (lock + back to confirm) and Esc (discard focus). Plain chars
        // fall through to the TextInput.
        if (replayEditingRef.current) {
          if (key.return || key.escape) setReplayEditing(false);
          return;
        }
        // CONFIRM state (defocused): y/f transmit, t edits the target, Esc cancels.
        if (key.escape) { setMode("list"); setNote("replay cancelled"); }
        else if (input === "y" || input === "f") fireReplay();
        else if (input === "t") setReplayEditing(true);
        return;
      }
      // list mode
      if (busyRef.current) return;
      const n = capturesRef.current.length;
      if (key.upArrow) setCursor((v) => clamp(v - 1, 0, Math.max(0, n - 1)));
      else if (key.downArrow) setCursor((v) => clamp(v + 1, 0, Math.max(0, n - 1)));
      else if (input === "a") analyzeSelected();
      else if (input === "c") { setNote(null); setMode("capture"); setCapField(0); }
      else if (input === "r") openReplay();
    },
    { isActive: rawOk },
  );

  const width = cols - 1;

  if (error && !s) {
    return (
      <Box flexDirection="column" width={width}>
        <ModuleHeader code="05 SDR-OFF" title="Offensive SDR" state="LINK ERROR" icon="☢" />
        <Tile title="ERROR" led="pink" width={Math.min(width, 60)}>
          <Text color={COLORS.pink}>sdr_offensive error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  const stateLabel = !s ? "ACQUIRING" : serverBusy ? "BUSY" : engaged ? "ARMED" : "SAFE";
  const compact = body <= 16;

  // ── status strip (v2 status: rx_device / tx_device / tx_capable / busy) ─────
  const rxLabel = s?.rx_device ?? "none";
  const txLabel = s?.tx_device ?? (txCapable ? "ready" : "none");
  const lastResult = s?.last_result ?? null;

  const statusStrip = compact ? (
    <Box>
      <StatusLED color={engaged ? "pink" : "mint"} />
      <Text color={engaged ? COLORS.pink : COLORS.mint}> {engaged ? "ARMED" : "SAFE"}</Text>
      <Text color={TEXT.dim}> · rx </Text>
      <Text color={rxLabel === "none" ? COLORS.amber : COLORS.cyan}>{rxLabel}</Text>
      <Text color={TEXT.dim}> · tx </Text>
      <Text color={txCapable ? COLORS.mint : COLORS.pink}>{txCapable ? "READY" : "none"}</Text>
      <Text color={TEXT.dim}> · {captures.length} cap · {serverBusy ? "busy" : "idle"}</Text>
    </Box>
  ) : (
    <Box flexDirection="row" gap={1}>
      <Tile title="RX" led={rxLabel === "none" ? "amber" : "mint"} width={22}>
        <Text color={rxLabel === "none" ? COLORS.amber : TEXT.hi}>{rxLabel}</Text>
        <Text color={TEXT.dim}>receive</Text>
      </Tile>
      <Tile title="TX CHAIN" led={txCapable ? "mint" : "pink"} width={26}>
        <Text color={txCapable ? COLORS.mint : COLORS.pink}>{txCapable ? "READY" : "NONE"}</Text>
        <Text color={TEXT.dim} wrap="truncate-end">{txCapable ? txLabel : "replay = file only"}</Text>
      </Tile>
      <Tile title="ENGINE" led={serverBusy ? "amber" : "violet"} width={20}>
        <Text color={serverBusy ? COLORS.amber : TEXT.body}>{serverBusy ? "running" : "idle"}</Text>
        <Text color={TEXT.dim} wrap="truncate-end">{s?.reason || (s?.ok ? "ok" : DASH)}</Text>
      </Tile>
      <Tile title="CAPTURES" led={captures.length ? "mint" : "amber"} width={18}>
        <Text color={COLORS.cyan}>{captures.length}</Text>
        <Text color={TEXT.dim}>IQ files</Text>
      </Tile>
    </Box>
  );

  // ── geometry budget for the captures list window ──────────────────────────
  // Non-compact strip = a row of round-border Tiles, each with 2 content lines →
  // border(1)+title(1)+content(2)+border(1) = 5 rows tall (NOT 4). Under-counting
  // here clips the last list row on the 160×45 deck (the W7 off-by-one).
  const stripRows = compact ? 1 : 5;
  const lastLine = lastResult ? `last ${lastResult.op ?? "op"}: ${lastResult.ok === false ? "FAILED " : ""}${lastResult.detail || lastResult.error || (lastResult.ok ? "ok" : DASH)}${lastResult.audit_id ? ` · audit ${String(lastResult.audit_id).slice(0, 8)}` : ""}` : null;
  let fixed = 1 /*header*/ + 1 /*gate*/ + stripRows + 1 /*footer*/;
  if (note || lastLine) fixed += 1; // note OR last_result share one row
  const listChrome = 2 /*border*/ + 1 /*title*/ + 1 /*colheader*/;
  const cap = Math.max(1, body - fixed - listChrome - 1 /*"+N more"*/);
  const ci = captures.length ? clamp(cursor, 0, captures.length - 1) : 0;
  const win = windowOf(captures, ci, cap);
  const listW = Math.max(48, Math.min(112, width));

  return (
    <Box flexDirection="column" width={width}>
      <ModuleHeader
        code="05 SDR-OFF"
        title="Offensive SDR"
        state={stateLabel}
        icon="☢"
        right={<Text color={TEXT.dim}>cap·analyze·replay · {captures.length}cap</Text>}
      />

      {/* engagement gate — pink "!" mirror of the web/nav flag */}
      {engaged ? (
        <Text wrap="truncate-end">
          <Text color={COLORS.mint}>◎ ENGAGED</Text>
          <Text color={TEXT.body}>{eng?.name ? ` ${eng.name}` : ""} — in-scope capture/replay run; replay still needs confirm. Out-of-scope 403s.</Text>
        </Text>
      ) : (
        <Text wrap="truncate-end">
          <Text bold color={COLORS.pink}>! ENGAGEMENT REQUIRED</Text>
          <Text color={TEXT.body}> — capture/replay are RF-gated (403) until active. Analyze is passive. g e → Operations.</Text>
        </Text>
      )}

      {statusStrip}

      {note ? (
        <Text color={note.startsWith("!") || note.includes("refused") || note.includes("failed") ? COLORS.pink : COLORS.amber} wrap="truncate-end">
          » {note}
        </Text>
      ) : lastLine ? (
        <Text color={lastResult?.ok === false ? COLORS.pink : TEXT.dim} wrap="truncate-end">
          ‹ {lastLine}
        </Text>
      ) : null}

      {/* ── CAPTURE form (mode) ── */}
      {mode === "capture" ? (
        <Tile title="● CAPTURE IQ — engagement-gated (RX)" led={engaged ? "violet" : "amber"} width={listW}>
          <Box>
            <Text color={capField === 0 ? COLORS.cyan : TEXT.dim}>{capField === 0 ? "›" : " "} freq MHz: </Text>
            {rawOk ? (
              <TextInput value={freqMhz} onChange={setFreqMhz} focus={capField === 0} />
            ) : (
              <Text color={TEXT.body}>{freqMhz}</Text>
            )}
          </Box>
          <Box>
            <Text color={capField === 1 ? COLORS.cyan : TEXT.dim}>{capField === 1 ? "›" : " "} duration s: </Text>
            {rawOk ? (
              <TextInput value={durationS} onChange={setDurationS} focus={capField === 1} />
            ) : (
              <Text color={TEXT.body}>{durationS}</Text>
            )}
          </Box>
          <Text color={TEXT.dim}>
            sr {DEFAULT_SR / 1e6}MS/s · auto radio · freq in MHz · ↑/↓ field · Enter fire · Esc cancel
            {engaged ? "" : " · gated: will 403 until engaged"}
          </Text>
        </Tile>
      ) : mode === "replay" ? (
        /* ── REPLAY confirm-before-transmit (mode) ── */
        <Tile title="⚠ CONFIRM RF REPLAY — TRANSMITS" led="pink" width={listW}>
          <Text color={COLORS.pink} wrap="truncate-end">
            About to TRANSMIT {capLabel(captures[ci] ?? {})} @ {fmtMhz(captures[ci] ?? {})}Hz.{" "}
            {txCapable ? "TX device present — WILL KEY THE TRANSMITTER." : "no TX device — prepares replay file only."}
          </Text>
          <Box>
            <Text color={replayEditing ? COLORS.cyan : COLORS.pink}>{replayEditing ? "› " : "  "}authorized target* : </Text>
            {rawOk ? (
              <TextInput value={replayTarget} onChange={setReplayTarget} focus={replayEditing} placeholder="in-scope SSID / BSSID / IP / label" />
            ) : (
              <Text color={TEXT.body}>{replayTarget || "(required)"}</Text>
            )}
          </Box>
          {scopeEntriesOf(eng).length ? (
            <Text color={TEXT.dim} wrap="truncate-end">scope: {scopeEntriesOf(eng).slice(0, 6).join(" · ")}</Text>
          ) : (
            <Text color={COLORS.amber} wrap="truncate-end">scope is empty — add an authorizing target on Operations (g e) first.</Text>
          )}
          {replayEditing ? (
            <Text color={COLORS.cyan}>type target · Enter = lock it in · Esc = back to confirm</Text>
          ) : (
            <Text color={COLORS.pink}>y / f = ⚠ CONFIRM TRANSMIT (RF) · t = edit target · Esc = cancel</Text>
          )}
        </Tile>
      ) : (
        /* ── CAPTURES list (mode = list) ── */
        <Tile title="CAPTURED SIGNALS" led={captures.length ? "mint" : "amber"} width={listW}>
          <Text color={TEXT.dim}>
            {"  "}
            {"file".padEnd(26)}
            {"freq".padStart(10)}
            {"dur".padStart(6)}
            {"size".padStart(7)}
            {"  demod"}
          </Text>
          {captures.length === 0 ? (
            <Text color={TEXT.dim}> no captures yet — press c to record IQ (garage / TPMS / 433 MHz), then a/r</Text>
          ) : (
            win.slice.map((c, i) => {
              const idx = win.start + i;
              const sel = idx === ci;
              return (
                <Text key={capLabel(c) + idx} wrap="truncate-end" color={sel ? COLORS.cyan : TEXT.body}>
                  {sel ? "▶ " : "  "}
                  {capLabel(c).slice(0, 26).padEnd(26)}
                  {fmtMhz(c).padStart(10)}
                  {(c.duration_s != null ? `${c.duration_s}s` : DASH).padStart(6)}
                  {fmtBytes(c.size_bytes).padStart(7)}
                  {"  "}
                  {c.modulation ?? DASH}
                </Text>
              );
            })
          )}
          {win.more > 0 ? <Text color={TEXT.dim}> +{win.more} more</Text> : null}
        </Tile>
      )}

      {/* footer key hints */}
      <Text color={TEXT.dim} wrap="truncate-end">
        {mode === "list"
          ? "↑/↓ select · a analyze (passive) · c capture (gated) · r replay (gated+confirm)"
          : mode === "capture"
            ? "capture mode — Enter fire · Esc cancel"
            : replayEditing
              ? "replay — editing target · Enter lock · Esc back"
              : "replay confirm — y/f TRANSMIT · t edit target · Esc cancel"}
      </Text>
    </Box>
  );
}
