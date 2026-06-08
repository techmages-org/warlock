// ============================================================================
// WIFI ANALYZER (wifi_analyzer) — AirCheck-class passive wireless survey.
// Mirrors the wifi_recon screen pattern against the SAME backend
// (src/warlock/modules/wifi_analyzer.py router()). Three Tab/1–3 views:
//
//   1 CHANNELS — POST /channels → per-band channel congestion (AP-count bar +
//       utilization%) and the least-congested recommendation per band. Polls ~4s.
//   2 SURVEY   — GET /walk/trace → dead-zone walk-test: zone summary (hot/warm/
//       cold/dead + dead_zones) + the recorded sample trace (windowed scroll).
//       Keys: r = record a sample (POST /walk/sample, auto label WP-N) ·
//       R (shift) = reset the trace (POST /walk/reset).
//   3 LOCATE   — AP location finder / fox-hunt. Picker: POST /scan, ↑/↓ select,
//       Enter → POST /locate/start. Meter: poll GET /locate/sample ~500ms →
//       prominent homing meter (RSSI, signal bar, warmer/colder trend, peak-hold,
//       proximity, coarse range). x = stop (POST /locate/stop) → back to picker.
//
// GEOMETRY: reads the live terminal via useStdout() and bounds every list to the
// rows/cols actually available (fallback 24x120 = design target & test default).
// ONE poll active at a time — each view's poll lives in a useEffect gated on the
// active `view` (and locate sub-state) so switching views tears the interval down.
// A re-entry probe (GET /locate/sample) resumes a backend locate session that
// out-lived a nav-away, so the operator can always reach the x = stop control.
//
// Passive / blue-team — requires_engagement = False, so there is NO gate UI.
// ============================================================================

import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

const CHROME_ROWS = 8;

// ----- backend shapes (src/warlock/modules/wifi_analyzer.py) -----------------
type ChanSlot = { channel: number; ap_count: number; utilization_pct: number | null };
type ChannelsResp = {
  ok: boolean;
  iface: string;
  channels: Record<string, ChanSlot[]>;
  least_congested: Record<string, number>;
};

type ScanAP = {
  bssid: string;
  associated: boolean;
  ssid: string | null;
  freq_mhz: number | null;
  signal_dbm: number | null;
  channel: number | null;
  band: string | null;
  quality: string;
};
type ScanResp = { ok: boolean; iface: string; count: number; by_band: Record<string, number>; aps: ScanAP[] };

type WalkSample = {
  ts: number;
  label: string | null;
  target: string | null;
  rssi_dbm: number | null;
  zone: string;
  bssid: string | null;
  channel: number | null;
  aps_visible: number | null;
};
type WalkSummary = {
  count: number;
  zones: Record<string, number>;
  dead_zones: number;
  min_dbm: number | null;
  max_dbm: number | null;
  avg_dbm: number | null;
};
type WalkResp = { ok: boolean; summary: WalkSummary; samples: WalkSample[] };

type LocateSample = {
  ok: boolean;
  active: boolean;
  bssid?: string | null;
  channel?: number | null;
  ssid?: string | null;
  peak_dbm?: number | null;
  rssi_dbm?: number | null;
  raw_dbm?: number | null;
  trend?: "warmer" | "colder" | "steady" | "no-signal";
  delta?: number | null;
  rate_hz?: number;
  samples?: number;
  proximity?: "very close" | "close" | "near" | "far" | "no-signal";
  est_range_ft?: number | null;
  peak_ago_s?: number | null;
};

// ----- views ----------------------------------------------------------------
type View = "channels" | "survey" | "locate";
const VIEWS: { id: View; label: string }[] = [
  { id: "channels", label: "Channels" },
  { id: "survey", label: "Survey" },
  { id: "locate", label: "Locate" },
];

const BAND_ORDER = ["2.4", "5", "6"];
const ZONE_COLOR: Record<string, LEDColor> = { hot: "mint", warm: "amber", cold: "cyan", dead: "pink" };

// ----- shared helpers (mirrors wifi_recon.tsx) ------------------------------
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useViewport() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 24;
  return { cols, rows, body: Math.max(6, rows - CHROME_ROWS) };
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

function dbmColor(dbm: number | null | undefined): LEDColor {
  if (dbm == null) return "dim";
  if (dbm >= -60) return "mint";
  if (dbm >= -75) return "amber";
  return "pink";
}

function bar(fill01: number, width: number): { filled: string; empty: string } {
  const n = clamp(Math.round(fill01 * width), 0, width);
  return { filled: "█".repeat(n), empty: "░".repeat(width - n) };
}

// Geiger-tick cadence: stronger signal → faster ticks. Linear map over a clamped
// RSSI window — -90 dBm → 1300 ms (slow blips), -35 dBm → 110 ms (fast chatter).
// Pure + exported so the mapping is unit-tested without a TTY.
export function geigerIntervalMs(rssi: number): number {
  const r = clamp(rssi, -90, -35);
  return Math.round(1300 + ((r + 90) / 55) * (110 - 1300));
}

// Terminal bell, written DIRECTLY to the real stdout — never through Ink's render
// tree (a BEL is non-printing, so it rings without disturbing the frame). Guarded
// on isTTY so headless test/CI runs and piped stdout stay silent; the deck is a TTY.
function emitBell(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write("\x07");
  } catch {
    /* stdout gone — ignore */
  }
}

// Flatten per-band channel maps into a single bounded row list (band headers +
// channel rows interleaved) so the whole thing windows like any other list.
type ChanRow =
  | { kind: "band"; band: string; rec: number | undefined; count: number }
  | { kind: "chan"; band: string; slot: ChanSlot; max: number };

function buildChanRows(d: ChannelsResp | null): ChanRow[] {
  if (!d) return [];
  const rows: ChanRow[] = [];
  for (const band of BAND_ORDER) {
    const chs = d.channels[band];
    if (!chs || chs.length === 0) continue;
    const max = Math.max(1, ...chs.map((c) => c.ap_count));
    rows.push({ kind: "band", band, rec: d.least_congested[band], count: chs.length });
    for (const slot of chs) rows.push({ kind: "chan", band, slot, max });
  }
  return rows;
}

export function Screen() {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { cols, body } = useViewport();

  const [view, setView] = useState<View>("channels");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // CHANNELS
  const [channels, setChannels] = useState<ChannelsResp | null>(null);
  const [chErr, setChErr] = useState<string | null>(null);
  const [chanSel, setChanSel] = useState(0);

  // SURVEY
  const [walk, setWalk] = useState<WalkResp | null>(null);
  const [walkErr, setWalkErr] = useState<string | null>(null);
  const [walkSel, setWalkSel] = useState(0);

  // LOCATE
  const [scan, setScan] = useState<ScanResp | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanNonce, setScanNonce] = useState(0);
  const [pickSel, setPickSel] = useState(0);
  const [locateActive, setLocateActive] = useState(false);
  const [locate, setLocate] = useState<LocateSample | null>(null);
  const [geigerOn, setGeigerOn] = useState(true); // homing bell — default ON

  // ----- view-gated polls (only the active view holds an interval) -----------
  useEffect(() => {
    if (view !== "channels") return;
    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await api.post<ChannelsResp>("/api/wifi_analyzer/channels", {});
        if (alive) { setChannels(d); setChErr(null); }
      } catch (e) {
        if (alive) setChErr(msg(e));
      } finally {
        inFlight = false;
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [api, view]);

  useEffect(() => {
    if (view !== "survey") return;
    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await api.get<WalkResp>("/api/wifi_analyzer/walk/trace");
        if (alive) { setWalk(d); setWalkErr(null); }
      } catch (e) {
        if (alive) setWalkErr(msg(e));
      } finally {
        inFlight = false;
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [api, view]);

  // Re-entry probe: if a backend locate session out-lived a nav-away, resume the
  // meter so the operator can still reach x = stop (start would otherwise 409).
  useEffect(() => {
    if (view !== "locate") return;
    let alive = true;
    (async () => {
      try {
        const s = await api.get<LocateSample>("/api/wifi_analyzer/locate/sample");
        if (alive && s?.active) { setLocate(s); setLocateActive(true); }
      } catch {
        /* probe is best-effort */
      }
    })();
    return () => { alive = false; };
  }, [api, view]);

  // Picker scan (one-shot per entry / rescan — no interval; scans are slow).
  useEffect(() => {
    if (view !== "locate" || locateActive) return;
    let alive = true;
    setScanLoading(true);
    (async () => {
      try {
        const d = await api.post<ScanResp>("/api/wifi_analyzer/scan", {});
        if (alive) { setScan(d); setScanErr(null); }
      } catch (e) {
        if (alive) setScanErr(msg(e));
      } finally {
        if (alive) setScanLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [api, view, locateActive, scanNonce]);

  // Locate meter poll (~500ms) — only while the session is active on this view.
  useEffect(() => {
    if (view !== "locate" || !locateActive) return;
    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await api.get<LocateSample>("/api/wifi_analyzer/locate/sample");
        if (alive) {
          setLocate(s);
          if (s && s.active === false) setLocateActive(false); // session died → back to picker
        }
      } catch {
        /* transient — keep last sample */
      } finally {
        inFlight = false;
      }
    };
    load();
    const t = setInterval(load, 500);
    return () => { alive = false; clearInterval(t); };
  }, [api, view, locateActive]);

  // ----- GEIGER homing bell --------------------------------------------------
  // A terminal bell (\x07) that ticks FASTER as the signal gets stronger — the
  // metal-detector "you're getting hotter" cue. Written straight to stdout (a
  // side-effect, NOT through the Ink render tree); a self-rescheduling timer reads
  // the latest RSSI each fire so the cadence re-times instantly as you move.
  const geigerOnRef = useLive(geigerOn);
  const rssiRef = useRef<number | null>(null);
  rssiRef.current = locate?.rssi_dbm ?? null;
  const peakRef = useRef<number | null>(null);

  useEffect(() => {
    if (view !== "locate" || !locateActive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      const rssi = rssiRef.current;
      let next = 320; // quiet idle re-check when muted / no signal (silent)
      if (geigerOnRef.current && rssi != null) {
        next = geigerIntervalMs(rssi);
        emitBell();
      }
      timer = setTimeout(tick, next);
    };
    timer = setTimeout(tick, 200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [view, locateActive]);

  // Peak ping: a sharper double-tick the instant a NEW peak is reached ("hottest
  // point yet" — you just got closer than ever). Seeds silently on first read; the
  // 45ms second bell is cancelled on unmount so it never beeps off-screen.
  useEffect(() => {
    const p = locate?.peak_dbm;
    if (p == null) return;
    const prev = peakRef.current;
    peakRef.current = p;
    if (prev == null || p <= prev || !geigerOnRef.current || !locateActive) return;
    emitBell();
    let cancelled = false;
    const t = setTimeout(() => { if (!cancelled) emitBell(); }, 45);
    return () => { cancelled = true; clearTimeout(t); };
  }, [locate?.peak_dbm, locateActive]);

  // ----- live refs for the input handler (avoid closure staleness) -----------
  const viewRef = useLive(view);
  const busyRef = useLive(busy);
  const localActiveRef = useLive(locateActive);
  const chanRows = buildChanRows(channels);
  const chanRowsRef = useLive(chanRows);
  const walkSamples = walk ? [...walk.samples].reverse() : []; // newest first
  const walkSamplesRef = useLive(walkSamples);
  const walkCountRef = useLive(walk?.summary.count ?? 0);
  const scanApsRef = useLive(scan?.aps ?? []);
  const pickSelRef = useLive(pickSel);

  // ----- actions -------------------------------------------------------------
  const record = async () => {
    setBusy(true);
    try {
      const label = `WP-${walkCountRef.current + 1}`;
      const r = await api.post<{ ok: boolean; sample: WalkSample }>("/api/wifi_analyzer/walk/sample", { label });
      const s = r?.sample;
      const z = s?.zone ?? "?";
      const rssi = s?.rssi_dbm != null ? `${s.rssi_dbm} dBm` : "no signal";
      setNote(`recorded ${label} — ${rssi} · zone ${z.toUpperCase()}`);
    } catch (e) {
      setNote(`record failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const resetWalk = async () => {
    setBusy(true);
    try {
      await api.post("/api/wifi_analyzer/walk/reset");
      setWalk(null);
      setWalkSel(0);
      setNote("walk-test trace reset — re-recording from WP-1");
    } catch (e) {
      setNote(`reset failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const startLocate = async () => {
    const ap = scanApsRef.current[pickSelRef.current];
    if (!ap) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; bssid: string; channel: number | null; ssid: string | null }>(
        "/api/wifi_analyzer/locate/start",
        { bssid: ap.bssid, channel: ap.channel ?? undefined },
      );
      setLocate(null);
      setLocateActive(true);
      setNote(`locking onto ${r?.ssid || ap.ssid || ap.bssid} · ch ${r?.channel ?? ap.channel ?? "?"}`);
    } catch (e) {
      setNote(`locate start failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const stopLocate = async () => {
    setBusy(true);
    try {
      await api.post("/api/wifi_analyzer/locate/stop");
      setLocateActive(false);
      setLocate(null);
      setScanNonce((n) => n + 1); // refresh the picker on return
      setNote("locate stopped — radio returned to managed mode");
    } catch (e) {
      setNote(`locate stop failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const switchView = (v: View) => {
    setView(v);
    setNote("");
    setChanSel(0);
    setWalkSel(0);
    setPickSel(0);
  };

  useInput(
    (input, key) => {
      if (key.tab) {
        switchView(VIEWS[(VIEWS.findIndex((x) => x.id === viewRef.current) + 1) % VIEWS.length].id);
        return;
      }
      if (input === "1") return switchView("channels");
      if (input === "2") return switchView("survey");
      if (input === "3") return switchView("locate");

      const v = viewRef.current;
      if (v === "channels") {
        const n = chanRowsRef.current.length;
        if (key.upArrow) setChanSel((s) => clamp(s - 1, 0, Math.max(0, n - 1)));
        else if (key.downArrow) setChanSel((s) => clamp(s + 1, 0, Math.max(0, n - 1)));
      } else if (v === "survey") {
        const n = walkSamplesRef.current.length;
        if (key.upArrow) setWalkSel((s) => clamp(s - 1, 0, Math.max(0, n - 1)));
        else if (key.downArrow) setWalkSel((s) => clamp(s + 1, 0, Math.max(0, n - 1)));
        else if (input === "r" && !busyRef.current) void record();
        else if (input === "R" && !busyRef.current) void resetWalk();
      } else if (v === "locate") {
        if (localActiveRef.current) {
          if (input === "x" && !busyRef.current) void stopLocate();
          else if (input === "b") setGeigerOn((g) => !g);
        } else {
          const n = scanApsRef.current.length;
          if (key.upArrow) setPickSel((s) => clamp(s - 1, 0, Math.max(0, n - 1)));
          else if (key.downArrow) setPickSel((s) => clamp(s + 1, 0, Math.max(0, n - 1)));
          else if (key.return && !busyRef.current) void startLocate();
          else if (input === "s" && !busyRef.current) setScanNonce((x) => x + 1);
        }
      }
    },
    { isActive: rawOk },
  );

  // ----- geometry: rows available for the active list ------------------------
  const noteRows = note ? 1 : 0;
  const outerFixed = 1 /*header*/ + 1 /*tabs*/ + 1 /*footer*/ + noteRows;
  // tile chrome: 2 border + 1 title + 1 colheader + 1 "+N more"
  const listCap = Math.max(1, body - outerFixed - 1 /*stat strip*/ - 5);

  const iface = channels?.iface ?? scan?.iface ?? null;
  const stateLabel =
    view === "channels" ? "CHANNELS" : view === "survey" ? "SURVEY" : locateActive ? "HOMING" : "LOCATE";

  const headerRight = (
    <Text color={TEXT.dim}>
      {iface ?? "—"}
      {view === "survey" && walk ? ` · ${walk.summary.count} wp` : null}
      {view === "locate" && !locateActive && scan ? ` · ${scan.count} AP` : null}
    </Text>
  );

  return (
    <Box flexDirection="column" width={cols - 1}>
      <ModuleHeader code="06 WIFI-ANL" title="WiFi Analyzer" state={stateLabel} icon="≋" right={headerRight} />

      {/* View tabs */}
      <Box>
        {VIEWS.map((vv, i) => {
          const on = vv.id === view;
          return (
            <Box key={vv.id} marginRight={1}>
              <Text bold={on} color={on ? COLORS.violet : TEXT.dim} backgroundColor={on ? "#1e1b2e" : undefined}>
                {" "}{i + 1} {vv.label}{" "}
              </Text>
            </Box>
          );
        })}
      </Box>

      {note ? (
        <Box>
          <Text color={COLORS.amber} wrap="truncate-end">» {note}</Text>
        </Box>
      ) : null}

      {view === "channels" && (
        <ChannelsView rows={chanRows} d={channels} err={chErr} cols={cols} sel={chanSel} cap={listCap + 1} />
      )}
      {view === "survey" && (
        <SurveyView walk={walk} samples={walkSamples} err={walkErr} cols={cols} sel={walkSel} cap={listCap} />
      )}
      {view === "locate" &&
        (locateActive ? (
          <LocateMeter s={locate} cols={cols} geigerOn={geigerOn} />
        ) : (
          <LocatePicker aps={scan?.aps ?? []} loading={scanLoading} err={scanErr} cols={cols} sel={pickSel} cap={listCap + 1} />
        ))}

      <Box>
        <Text color={TEXT.dim} wrap="truncate-end">
          Tab/1–3 view
          {view === "channels"
            ? " · ↑/↓ scroll"
            : view === "survey"
              ? " · ↑/↓ scroll · r record · R reset"
              : locateActive
                ? " · x stop · b geiger"
                : " · ↑/↓ select · ↵ start · s rescan"}
        </Text>
      </Box>
    </Box>
  );
}

// ----- CHANNELS --------------------------------------------------------------
function ChannelsView({
  rows,
  d,
  err,
  cols,
  sel,
  cap,
}: {
  rows: ChanRow[];
  d: ChannelsResp | null;
  err: string | null;
  cols: number;
  sel: number;
  cap: number;
}) {
  if (err && !d) {
    return (
      <Tile title="CHANNEL CONGESTION" led="pink" width={Math.min(cols - 1, 64)}>
        <Text color={COLORS.pink} wrap="truncate-end">scan/survey error: {err}</Text>
      </Tile>
    );
  }
  if (!d) {
    return (
      <Tile title="CHANNEL CONGESTION" led="amber" width={Math.min(cols - 1, 40)}>
        <Text color={TEXT.dim}>scanning channels… (iw scan + survey)</Text>
      </Tile>
    );
  }
  const win = windowOf(rows, sel, cap);
  const recline = BAND_ORDER.filter((b) => d.least_congested[b] != null)
    .map((b) => `${b}G→ch${d.least_congested[b]}`)
    .join("  ");
  return (
    <Tile
      title={`CHANNEL CONGESTION (${rows.filter((r) => r.kind === "chan").length} ch)`}
      led={rows.length ? "mint" : "amber"}
      width={cols - 1}
    >
      <Box>
        <Box width={3}><Text color={TEXT.dim}> </Text></Box>
        <Box width={8}><Text color={TEXT.dim}>CHAN</Text></Box>
        <Box width={16}><Text color={TEXT.dim}>APs</Text></Box>
        <Box width={7}><Text color={TEXT.dim}>CNT</Text></Box>
        <Box><Text color={TEXT.dim}>UTILIZATION</Text></Box>
      </Box>
      {rows.length === 0 ? (
        <Text color={TEXT.dim}>no APs seen on any channel yet</Text>
      ) : (
        win.slice.map((row, i) => {
          if (row.kind === "band") {
            return (
              <Box key={`b-${row.band}-${i}`}>
                <Text color={COLORS.violet} bold>
                  {row.band} GHz
                </Text>
                <Text color={TEXT.dim}>
                  {"  "}({row.count} ch){row.rec != null ? `  least-congested → ch ${row.rec}` : ""}
                </Text>
              </Box>
            );
          }
          const idx = rows.indexOf(row);
          const on = idx === sel;
          const { filled, empty } = bar(row.slot.ap_count / row.max, 10);
          const util = row.slot.utilization_pct;
          return (
            <Box key={`c-${row.band}-${row.slot.channel}`}>
              <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
              <Box width={8}><Text color={on ? TEXT.hi : TEXT.body}>ch {String(row.slot.channel).padStart(3)}</Text></Box>
              <Box width={16}>
                <Text color={COLORS.amber}>{filled}</Text>
                <Text color={TEXT.dim}>{empty}</Text>
              </Box>
              <Box width={7}><Text color={TEXT.body}>{String(row.slot.ap_count).padStart(2)} AP</Text></Box>
              <Box>
                {util != null ? (
                  <Text color={util >= 60 ? COLORS.pink : util >= 30 ? COLORS.amber : COLORS.mint}>{util}% busy</Text>
                ) : (
                  <Text color={TEXT.dim}>—</Text>
                )}
              </Box>
            </Box>
          );
        })
      )}
      {win.more > 0 ? (
        <Text color={TEXT.dim}>  +{win.more} more — ↑/↓ to scroll · best: {recline}</Text>
      ) : recline ? (
        <Text color={TEXT.dim}>  best channels: {recline}</Text>
      ) : null}
    </Tile>
  );
}

// ----- SURVEY (dead-zone walk test) -----------------------------------------
function SurveyView({
  walk,
  samples,
  err,
  cols,
  sel,
  cap,
}: {
  walk: WalkResp | null;
  samples: WalkSample[];
  err: string | null;
  cols: number;
  sel: number;
  cap: number;
}) {
  const sum = walk?.summary;
  const z = sum?.zones ?? {};
  return (
    <Box flexDirection="column">
      {/* zone summary strip */}
      <Box>
        <Text color={COLORS.mint}>hot {z.hot ?? 0}</Text>
        <Text color={TEXT.dim}> · </Text>
        <Text color={COLORS.amber}>warm {z.warm ?? 0}</Text>
        <Text color={TEXT.dim}> · </Text>
        <Text color={COLORS.cyan}>cold {z.cold ?? 0}</Text>
        <Text color={TEXT.dim}> · </Text>
        <StatusLED color={(sum?.dead_zones ?? 0) > 0 ? "pink" : "dim"} />
        <Text color={(sum?.dead_zones ?? 0) > 0 ? COLORS.pink : TEXT.dim} bold={(sum?.dead_zones ?? 0) > 0}>
          {" "}DEAD {sum?.dead_zones ?? 0}
        </Text>
        <Text color={TEXT.dim}>
          {"  ·  "}avg {sum?.avg_dbm != null ? `${sum.avg_dbm}` : "—"} · min {sum?.min_dbm ?? "—"} · max {sum?.max_dbm ?? "—"} dBm
        </Text>
      </Box>

      <Tile
        title={`WALK SAMPLES (${sum?.count ?? 0})`}
        led={(sum?.dead_zones ?? 0) > 0 ? "pink" : sum?.count ? "mint" : "amber"}
        width={cols - 1}
      >
        <Box>
          <Box width={3}><Text color={TEXT.dim}> </Text></Box>
          <Box width={9}><Text color={TEXT.dim}>WP</Text></Box>
          <Box width={22}><Text color={TEXT.dim}>TARGET</Text></Box>
          <Box width={10}><Text color={TEXT.dim}>RSSI</Text></Box>
          <Box width={7}><Text color={TEXT.dim}>ZONE</Text></Box>
          <Box width={7}><Text color={TEXT.dim}>CH</Text></Box>
          <Box><Text color={TEXT.dim}>VIS</Text></Box>
        </Box>
        {err && !walk ? (
          <Text color={COLORS.pink} wrap="truncate-end">trace error: {err}</Text>
        ) : (sum?.count ?? 0) === 0 ? (
          <Text color={TEXT.dim}>no samples yet — walk the site, press r to record a waypoint</Text>
        ) : (
          (() => {
            const win = windowOf(samples, sel, cap);
            return (
              <>
                {win.slice.map((s, i) => {
                  const idx = samples.indexOf(s);
                  const on = idx === sel;
                  const zc = ZONE_COLOR[s.zone] ?? "dim";
                  return (
                    <Box key={`${s.ts}-${idx}-${i}`}>
                      <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
                      <Box width={9}><Text color={on ? TEXT.hi : TEXT.body}>{s.label ?? "—"}</Text></Box>
                      <Box width={22}><Text color={s.target ? COLORS.violet : TEXT.dim} wrap="truncate-end">{s.target ?? "—"}</Text></Box>
                      <Box width={10}>
                        <Text color={COLORS[dbmColor(s.rssi_dbm)]}>{s.rssi_dbm != null ? `${s.rssi_dbm} dBm` : "—"}</Text>
                      </Box>
                      <Box width={7}><Text color={COLORS[zc]}>{s.zone.toUpperCase()}</Text></Box>
                      <Box width={7}><Text color={TEXT.body}>{s.channel != null ? `ch${s.channel}` : "—"}</Text></Box>
                      <Box><Text color={TEXT.dim}>{s.aps_visible != null ? s.aps_visible : "—"}</Text></Box>
                    </Box>
                  );
                })}
                {win.more > 0 ? (
                  <Text color={TEXT.dim}>  +{win.more} more — ↑/↓ to scroll ({sel + 1}/{samples.length})</Text>
                ) : null}
              </>
            );
          })()
        )}
      </Tile>
    </Box>
  );
}

// ----- LOCATE picker ---------------------------------------------------------
function LocatePicker({
  aps,
  loading,
  err,
  cols,
  sel,
  cap,
}: {
  aps: ScanAP[];
  loading: boolean;
  err: string | null;
  cols: number;
  sel: number;
  cap: number;
}) {
  if (err && aps.length === 0) {
    return (
      <Tile title="SELECT TARGET" led="pink" width={Math.min(cols - 1, 64)}>
        <Text color={COLORS.pink} wrap="truncate-end">scan error: {err}</Text>
      </Tile>
    );
  }
  if (loading && aps.length === 0) {
    return (
      <Tile title="SELECT TARGET" led="amber" width={Math.min(cols - 1, 40)}>
        <Text color={TEXT.dim}>scanning for targets… (iw scan)</Text>
      </Tile>
    );
  }
  const win = windowOf(aps, sel, cap);
  return (
    <Tile title={`SELECT TARGET (${aps.length} APs)`} led={aps.length ? "violet" : "amber"} width={cols - 1}>
      <Box>
        <Box width={3}><Text color={TEXT.dim}> </Text></Box>
        <Box width={18}><Text color={TEXT.dim}>BSSID</Text></Box>
        <Box width={22}><Text color={TEXT.dim}>SSID</Text></Box>
        <Box width={6}><Text color={TEXT.dim}>BAND</Text></Box>
        <Box width={7}><Text color={TEXT.dim}>CH</Text></Box>
        <Box width={10}><Text color={TEXT.dim}>RSSI</Text></Box>
        <Box width={11}><Text color={TEXT.dim}>QUALITY</Text></Box>
        <Box><Text color={TEXT.dim}>ASSOC</Text></Box>
      </Box>
      {aps.length === 0 ? (
        <Text color={TEXT.dim}>no APs found — press s to rescan</Text>
      ) : (
        win.slice.map((a, i) => {
          const idx = aps.indexOf(a);
          const on = idx === sel;
          return (
            <Box key={`${a.bssid}-${i}`}>
              <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
              <Box width={18}><Text color={on ? TEXT.hi : TEXT.body}>{a.bssid}</Text></Box>
              <Box width={22}><Text color={a.ssid && a.ssid !== "(hidden)" ? COLORS.violet : TEXT.dim} wrap="truncate-end">{a.ssid || "—"}</Text></Box>
              <Box width={6}><Text color={TEXT.body}>{a.band ? `${a.band}G` : "—"}</Text></Box>
              <Box width={7}><Text color={TEXT.body}>{a.channel != null ? `ch${a.channel}` : "—"}</Text></Box>
              <Box width={10}><Text color={COLORS[dbmColor(a.signal_dbm)]}>{a.signal_dbm != null ? `${a.signal_dbm}` : "—"}</Text></Box>
              <Box width={11}><Text color={TEXT.dim}>{a.quality}</Text></Box>
              <Box><Text color={a.associated ? COLORS.mint : TEXT.dim}>{a.associated ? "● assoc" : "—"}</Text></Box>
            </Box>
          );
        })
      )}
      {win.more > 0 ? <Text color={TEXT.dim}>  +{win.more} more — ↑/↓ to scroll ({sel + 1}/{aps.length})</Text> : null}
    </Tile>
  );
}

// ----- LOCATE meter (fox-hunt homing) ---------------------------------------
const TREND: Record<string, { glyph: string; word: string; color: LEDColor }> = {
  warmer: { glyph: "▲", word: "WARMER", color: "mint" },
  colder: { glyph: "▼", word: "COLDER", color: "pink" },
  steady: { glyph: "●", word: "STEADY", color: "amber" },
  "no-signal": { glyph: "…", word: "ACQUIRING", color: "dim" },
};

function LocateMeter({ s, cols, geigerOn }: { s: LocateSample | null; cols: number; geigerOn: boolean }) {
  const width = Math.min(cols - 1, 78);
  const target = s?.ssid || s?.bssid || "target";
  const rssi = s?.rssi_dbm ?? null;
  const acquiring = !s || s.active === false || rssi == null;
  const tr = TREND[s?.trend ?? "no-signal"] ?? TREND["no-signal"];
  const barW = Math.min(width - 8, 40);
  const { filled, empty } = bar(rssi != null ? (rssi + 90) / 60 : 0, barW);
  const prox = (s?.proximity ?? "no-signal").toUpperCase();
  const delta = s?.delta;

  return (
    <Tile
      title={`HOMING — ${target}  ch ${s?.channel ?? "?"}`}
      led={acquiring ? "amber" : dbmColor(rssi)}
      width={width}
    >
      {/* trend (big) */}
      <Box>
        <Text color={COLORS[tr.color]} bold>{tr.glyph} {tr.word}</Text>
        {delta != null && !acquiring ? (
          <Text color={TEXT.dim}>   {delta >= 0 ? "+" : ""}{delta} dB / 3s</Text>
        ) : null}
      </Box>
      {/* RSSI (big number) + signal bar */}
      <Box>
        <Text color={COLORS[dbmColor(rssi)]} bold>{rssi != null ? String(rssi).padStart(4) : "  --"}</Text>
        <Text color={TEXT.dim}> dBm  </Text>
        <Text color={COLORS[dbmColor(rssi)]}>{filled}</Text>
        <Text color={TEXT.dim}>{empty}</Text>
        {s?.raw_dbm != null ? <Text color={TEXT.dim}>  raw {s.raw_dbm}</Text> : null}
      </Box>
      {/* proximity + coarse range */}
      <Box>
        <Text color={acquiring ? TEXT.dim : COLORS[dbmColor(rssi)]} bold>{prox}</Text>
        <Text color={TEXT.dim}>
          {"   "}
          {s?.est_range_ft != null ? `~${s.est_range_ft} ft (approx — indoors unreliable)` : "range —"}
        </Text>
      </Box>
      {/* peak hold */}
      <Box>
        <Text color={TEXT.dim}>peak </Text>
        <Text color={COLORS.violet}>{s?.peak_dbm != null ? `${s.peak_dbm} dBm` : "—"}</Text>
        <Text color={TEXT.dim}>{s?.peak_ago_s != null ? `, ${s.peak_ago_s}s ago` : ""}</Text>
      </Box>
      {/* rate + samples + geiger state (small) */}
      <Box>
        <Text color={geigerOn ? COLORS.mint : TEXT.dim}>{geigerOn ? "♪ geiger" : "✕ muted"}</Text>
        <Text color={TEXT.dim}> (b) · </Text>
        <Text color={TEXT.dim}>
          {s?.rate_hz ?? 0} Hz · {s?.samples ?? 0} samples
          {acquiring ? "   · hold position, waiting for beacons…" : ""}
        </Text>
      </Box>
    </Tile>
  );
}
