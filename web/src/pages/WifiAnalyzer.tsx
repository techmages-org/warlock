import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, SignalBars, StatusLED, Tile } from "../components/hud";

// ---------------------------------------------------------------------------
// WiFi Analyzer — AirCheck-class passive wireless survey (Track A / A3).
//
// Three operator workflows, mirrored from the TUI:
//   CHANNELS — per-band channel congestion (AP count + utilization%) + the
//              least-congested recommendation. Poll ~4 s.
//   SURVEY   — dead-zone walk-test: record RSSI samples at waypoints, see the
//              coverage zone breakdown (hot/warm/cold/dead). Poll trace ~4 s.
//   LOCATE   — AP location finder ("fox hunt"): lock a target BSSID and read a
//              real-time homing meter (warmer/colder + peak-hold). Poll 500 ms.
//
// Passive / blue-team — NO engagement gate (module.requires_engagement=False).
// Every field is read defensively (channel/band/util/rssi may be null) so the
// page renders as a real instrument even on partial data.
// ---------------------------------------------------------------------------

const DASH = "—";

type AnalyzerStatus = {
  ok: boolean;
  iface: string;
  link: {
    connected: boolean;
    iface?: string;
    ssid?: string | null;
    bssid?: string | null;
    signal_dbm?: number | null;
    quality?: string;
  };
  tools: { iw: boolean; nmcli: boolean };
};

type ChannelSlot = { channel: number; ap_count: number; utilization_pct: number | null };
type ChannelsResp = {
  ok: boolean;
  iface: string;
  channels: Record<string, ChannelSlot[]>;
  least_congested: Record<string, number>;
};

type WalkSample = {
  ts: number;
  label: string | null;
  target: string | null;
  rssi_dbm: number | null;
  zone: string;
  bssid: string | null;
  channel: number | null;
  aps_visible?: number | null;
};
type WalkTrace = {
  ok: boolean;
  summary: {
    count: number;
    zones: Record<string, number>;
    dead_zones: number;
    min_dbm: number | null;
    max_dbm: number | null;
    avg_dbm: number | null;
  };
  samples: WalkSample[];
};

// NOTE: wifi_analyzer/scan APs use `ssid` + `signal_dbm` (NOT essid/signal like
// wifi_recon). channel/band/freq_mhz can be null.
type ScanAP = {
  bssid: string;
  ssid: string | null;
  freq_mhz: number | null;
  signal_dbm: number | null;
  associated: boolean;
  channel: number | null;
  band: string | null;
  quality: string;
};
type ScanResp = {
  ok: boolean;
  iface: string;
  count: number;
  by_band: Record<string, number>;
  aps: ScanAP[];
};

type Trend = "warmer" | "colder" | "steady" | "no-signal";
type LocateSample = {
  ok: boolean;
  active: boolean;
  bssid?: string | null;
  channel?: number | null;
  ssid?: string | null;
  peak_dbm?: number | null;
  rssi_dbm?: number | null;
  raw_dbm?: number | null;
  trend?: Trend;
  delta?: number | null;
  rate_hz?: number;
  samples?: number;
  proximity?: string;
  est_range_ft?: number | null;
  peak_ago_s?: number | null;
};

type Tab = "channels" | "survey" | "locate";
const TABS: { id: Tab; label: string }[] = [
  { id: "channels", label: "Channels" },
  { id: "survey", label: "Survey" },
  { id: "locate", label: "Locate" },
];

// Coverage zone palette (mirrors the TUI): hot=mint, warm=amber, cold=cyan, dead=pink.
type ZoneColor = "mint" | "amber" | "cyan" | "pink" | "dim";
function zoneColor(zone: string): ZoneColor {
  switch (zone) {
    case "hot": return "mint";
    case "warm": return "amber";
    case "cold": return "cyan";
    case "dead": return "pink";
    default: return "dim";
  }
}
const ZONE_TEXT: Record<ZoneColor, string> = {
  mint: "text-mint-safe",
  amber: "text-amber-base",
  cyan: "text-cyan-signal",
  pink: "text-pink-alert",
  dim: "text-txt-dim",
};

const BAND_ORDER = ["2.4", "5", "6"];
function bandLabel(b: string): string {
  return b === "2.4" ? "2.4 GHz" : b === "5" ? "5 GHz" : b === "6" ? "6 GHz" : `${b} GHz`;
}

// LOCATE search modes — the pluggable seam. geiger + sonar are audio; wave is
// a visual oscilloscope. Add a mode here, a case in LocateAudio.start/stop
// Generators (if it makes sound), and a branch in the meter render.
type LocateMode = "geiger" | "sonar" | "wave";
const LOCATE_MODES: { id: LocateMode; label: string; hint: string }[] = [
  { id: "geiger", label: "☢ Geiger", hint: "click ticks — faster = closer" },
  { id: "sonar", label: "🔉 Sonar", hint: "continuous tone — higher pitch = closer" },
  { id: "wave", label: "∿ Wave", hint: "live oscilloscope (visual)" },
];

// --------------------------------------------------------------------------- //
// LOCATE audio engine — MODE-PLUGGABLE, all modes driven off the same RSSI      //
// sample stream. Adding a new audio mode = one case in start/stopGenerators     //
// (+ optionally update()); the render seam is the `LocateMode` enum that the     //
// selector and <WaveScope> already switch on.                                   //
//                                                                              //
//   geiger — a self-rescheduling "tick" that speeds up as signal strengthens   //
//            (rssi[-90,-35] → ~1300ms far … ~110ms close); a higher-pitched    //
//            ping fires on each new peak. No signal → silence.                 //
//   sonar  — a CONTINUOUS tone whose PITCH tracks signal (rssi[-90,-35] →      //
//            220..1200 Hz; higher = closer; theremin/sonar feel).             //
//   wave   — visual-only (see <WaveScope>); the engine stays silent.          //
//                                                                              //
// The AudioContext is created/resumed only from a user gesture (arm(), on the  //
// Start-locate click / audio toggle) to satisfy autoplay policy, and is fully  //
// torn down on stop/unmount.                                                   //
// --------------------------------------------------------------------------- //
class LocateAudio {
  private ctx: AudioContext | null = null;
  private mode: LocateMode = "geiger";
  private muted = false;
  private running = false;
  private currentRssi: number | null = null;
  private lastPeak: number | null = null;
  // geiger
  private timer: number | null = null;
  // sonar
  private osc: OscillatorNode | null = null;
  private sonarGain: GainNode | null = null;

  /** Create/resume the AudioContext — MUST be invoked from a user gesture. */
  arm(): void {
    try {
      if (!this.ctx) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      /* audio is best-effort — never let it break the meter */
    }
  }

  setMode(m: LocateMode): void {
    if (m === this.mode) return;
    const wasRunning = this.running;
    if (wasRunning) this.stopGenerators();
    this.mode = m;
    if (wasRunning) this.startGenerators();
  }

  setMuted(m: boolean): void {
    // Just flip the flag — never create the ctx here (runs from a mount effect,
    // not a gesture). Sonar reflects the change live.
    this.muted = m;
    this.applySonar();
  }

  start(): void {
    this.arm();
    this.lastPeak = null;
    this.currentRssi = null;
    if (this.running) return;
    this.running = true;
    this.startGenerators();
  }

  /** Halt all generators and suspend audio (resumable on a later start()). */
  stop(): void {
    this.running = false;
    this.stopGenerators();
    if (this.ctx && this.ctx.state === "running") {
      try { void this.ctx.suspend(); } catch { /**/ }
    }
  }

  /** Permanent teardown — close the context so nothing leaks/plays off-page. */
  dispose(): void {
    this.running = false;
    this.stopGenerators();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      try { void ctx.close(); } catch { /**/ }
    }
  }

  /** Feed the latest sample each poll. */
  update(rssi: number | null | undefined, peak: number | null | undefined): void {
    this.currentRssi = rssi ?? null;
    // peak ping — geiger only (sonar conveys "hotter" via rising pitch).
    if (peak != null && this.mode === "geiger" && this.lastPeak != null && peak > this.lastPeak && !this.muted) {
      this.tick(1600);
    }
    if (peak != null && (this.lastPeak == null || peak > this.lastPeak)) this.lastPeak = peak;
    this.applySonar(); // live pitch/gain when in sonar mode
  }

  // ----- generator dispatch (the mode seam) --------------------------------
  private startGenerators(): void {
    if (this.mode === "geiger") this.schedule();
    else if (this.mode === "sonar") this.startSonar();
    // "wave" is visual-only — no audio generator.
  }

  private stopGenerators(): void {
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null; }
    this.stopSonar();
  }

  // ----- geiger ------------------------------------------------------------
  private intervalMs(rssi: number): number {
    const lo = -90, hi = -35;
    const clamped = Math.max(lo, Math.min(hi, rssi));
    const t = (clamped - lo) / (hi - lo); // 0 at -90 (far) … 1 at -35 (close)
    return Math.round(1300 + t * (110 - 1300)); // 1300ms far → 110ms close
  }

  private schedule = (): void => {
    if (!this.running || this.mode !== "geiger") return;
    const rssi = this.currentRssi;
    let next = 300; // quiet recheck cadence while there's no signal
    if (rssi != null) {
      next = this.intervalMs(rssi);
      if (!this.muted) this.tick(1000);
    }
    this.timer = window.setTimeout(this.schedule, next);
  };

  private tick(freq: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      // ~25ms click: fast attack then exponential decay so it reads as a "tick".
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.03);
    } catch {
      /* a single dropped tick is fine */
    }
  }

  // ----- sonar -------------------------------------------------------------
  private sonarHz(rssi: number): number {
    const lo = -90, hi = -35;
    const clamped = Math.max(lo, Math.min(hi, rssi));
    const t = (clamped - lo) / (hi - lo);
    return 220 + t * (1200 - 220); // 220Hz far → 1200Hz close
  }

  private startSonar(): void {
    const ctx = this.ctx;
    if (!ctx || this.osc) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = this.currentRssi != null ? this.sonarHz(this.currentRssi) : 220;
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      this.osc = osc;
      this.sonarGain = gain;
      this.applySonar();
    } catch { /**/ }
  }

  private applySonar(): void {
    const ctx = this.ctx;
    if (!ctx || !this.osc || !this.sonarGain || this.mode !== "sonar") return;
    const r = this.currentRssi;
    try {
      if (r != null) this.osc.frequency.setTargetAtTime(this.sonarHz(r), ctx.currentTime, 0.04);
      const audible = this.running && !this.muted && r != null;
      this.sonarGain.gain.setTargetAtTime(audible ? 0.085 : 0.0001, ctx.currentTime, 0.05);
    } catch { /**/ }
  }

  private stopSonar(): void {
    const ctx = this.ctx;
    const osc = this.osc;
    const gain = this.sonarGain;
    this.osc = null;
    this.sonarGain = null;
    if (ctx && gain) {
      try { gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02); } catch { /**/ }
    }
    if (osc) {
      // brief fade-out before stopping so it doesn't click off.
      try { osc.stop(ctx ? ctx.currentTime + 0.06 : 0); } catch { /**/ }
    }
  }
}

export function WifiAnalyzer() {
  const [tab, setTab] = useState<Tab>("channels");
  const [status, setStatus] = useState<AnalyzerStatus | null>(null);
  const [note, setNote] = useState<string>("");

  // CHANNELS
  const [channels, setChannels] = useState<ChannelsResp | null>(null);
  // SURVEY
  const [trace, setTrace] = useState<WalkTrace | null>(null);
  const [walkBusy, setWalkBusy] = useState<string | null>(null);
  // LOCATE
  const [scanAps, setScanAps] = useState<ScanAP[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [locate, setLocate] = useState<LocateSample | null>(null);
  const [locBusy, setLocBusy] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(true); // ticks/tone ON by default
  const [mode, setMode] = useState<LocateMode>("geiger"); // pluggable search mode

  // LOCATE audio engine — instantiated once (no AudioContext until armed by a
  // user gesture). Survives re-renders via the ref.
  const audioRef = useRef<LocateAudio | null>(null);
  if (audioRef.current === null) audioRef.current = new LocateAudio();

  // header iface — fetched once (status calls live `iw` so we don't poll it).
  useEffect(() => {
    let alive = true;
    apiGet<AnalyzerStatus>("/api/wifi_analyzer/status")
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // --- CHANNELS poll (~4 s). NOTE: POST requires a body → send {} or 422. -----
  useEffect(() => {
    if (tab !== "channels") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiPost<ChannelsResp>("/api/wifi_analyzer/channels", {});
        if (alive) setChannels(d);
      } catch (e) { if (alive) setNote(`channels: ${String(e)}`); }
    };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  // --- SURVEY poll (~4 s) ----------------------------------------------------
  useEffect(() => {
    if (tab !== "survey") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<WalkTrace>("/api/wifi_analyzer/walk/trace");
        if (alive) setTrace(d);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  // --- LOCATE poll (500 ms, always-on while on tab; UI driven off `active`).
  // Only one poll runs at a time (tab-gated); cleaned up on tab-leave/unmount.
  useEffect(() => {
    if (tab !== "locate") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<LocateSample>("/api/wifi_analyzer/locate/sample");
        if (alive) setLocate(d);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 500);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  // --- Geiger audio: drive the tick engine off the live locate session ------
  // start()/stop() are keyed on the session being active (NOT the Start click),
  // so an externally-ended session also silences the ticks. The AudioContext is
  // armed separately on the click gesture (see startLocate) to satisfy autoplay.
  const locating = locate?.active === true;
  useEffect(() => {
    const g = audioRef.current;
    if (!g) return;
    if (locating) g.start();
    else g.stop();
  }, [locating]);

  useEffect(() => {
    audioRef.current?.setMuted(!audioOn);
  }, [audioOn]);

  useEffect(() => {
    audioRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    audioRef.current?.update(locate?.rssi_dbm, locate?.peak_dbm);
  }, [locate]);

  // Permanent teardown on page unmount — close the AudioContext so it can never
  // leak or keep ticking off-page.
  useEffect(() => () => audioRef.current?.dispose(), []);

  const recordSample = useCallback(async () => {
    const next = (trace?.summary.count ?? 0) + 1;
    const label = `WP-${next}`;
    setWalkBusy("sample");
    try {
      const d = await apiPost<{ sample: WalkSample }>("/api/wifi_analyzer/walk/sample", { label });
      const s = d.sample;
      setNote(
        `recorded ${s.label ?? label} — ${s.rssi_dbm != null ? `${s.rssi_dbm} dBm` : "no signal"} ` +
        `(${s.zone}${s.target ? ` · ${s.target}` : ""})`,
      );
      try {
        const t = await apiGet<WalkTrace>("/api/wifi_analyzer/walk/trace");
        setTrace(t);
      } catch { /**/ }
    } catch (e) { setNote(`record failed: ${String(e)}`); }
    finally { setWalkBusy(null); }
  }, [trace]);

  const resetWalk = useCallback(async () => {
    setWalkBusy("reset");
    try {
      await apiPost("/api/wifi_analyzer/walk/reset");
      setNote("walk-test reset — trace cleared");
      setTrace({ ok: true, summary: { count: 0, zones: {}, dead_zones: 0, min_dbm: null, max_dbm: null, avg_dbm: null }, samples: [] });
    } catch (e) { setNote(`reset failed: ${String(e)}`); }
    finally { setWalkBusy(null); }
  }, []);

  const scanForTargets = useCallback(async () => {
    setScanBusy(true);
    try {
      // POST requires a body → send {} or the endpoint 422s.
      const d = await apiPost<ScanResp>("/api/wifi_analyzer/scan", {});
      setScanAps(d.aps || []);
      setNote(`scanned ${d.iface} — ${d.count} APs`);
    } catch (e) { setNote(`scan failed: ${String(e)}`); }
    finally { setScanBusy(false); }
  }, []);

  const startLocate = useCallback(async (ap: ScanAP) => {
    // Arm the AudioContext NOW, synchronously inside the click gesture, so the
    // browser autoplay policy lets the geiger ticks sound once the session goes
    // active. The tick loop itself is started by the `locating` effect.
    audioRef.current?.arm();
    setLocBusy("start");
    try {
      await apiPost("/api/wifi_analyzer/locate/start", { bssid: ap.bssid, channel: ap.channel });
      setNote(`homing on ${ap.ssid || ap.bssid} (ch ${ap.channel ?? "?"}) — locking radio to monitor`);
    } catch (e) { setNote(`locate start failed: ${String(e)}`); }
    finally { setLocBusy(null); }
  }, []);

  const stopLocate = useCallback(async () => {
    setLocBusy("stop");
    try {
      await apiPost("/api/wifi_analyzer/locate/stop");
      setNote("locate stopped — radio returned to managed mode");
      setLocate({ ok: true, active: false });
    } catch (e) { setNote(`locate stop failed: ${String(e)}`); }
    finally { setLocBusy(null); }
  }, []);

  // Toggling is a user gesture → re-arm the ctx (covers the case where a session
  // was already active on tab-entry and was never armed by a Start click).
  const toggleAudio = useCallback(() => {
    audioRef.current?.arm();
    setAudioOn((v) => !v);
  }, []);

  const iface = status?.iface ?? channels?.iface ?? null;
  const stateLabel = locating ? "HOMING" : status == null ? "ACQUIRING" : "PASSIVE";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="A3 WIFI-ANL"
        title="WiFi Analyzer — survey · channels · locate"
        state={stateLabel}
        icon="≋"
        right={
          <span className="hud-label text-txt-dim">
            {iface ?? DASH}
            {status?.link?.connected && status.link.ssid ? (
              <> · <span className="text-violet-bright">{status.link.ssid}</span></>
            ) : null}
            {" · "}
            <span className="text-cyan-signal">{tab.toUpperCase()}</span>
          </span>
        }
      />

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="hud-btn"
            data-active={tab === t.id ? "true" : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      {tab === "channels" && <ChannelsTab data={channels} />}
      {tab === "survey" && (
        <SurveyTab
          trace={trace}
          busy={walkBusy}
          onRecord={recordSample}
          onReset={resetWalk}
        />
      )}
      {tab === "locate" && (
        <LocateTab
          locate={locate}
          locating={locating}
          scanAps={scanAps}
          scanBusy={scanBusy}
          locBusy={locBusy}
          audioOn={audioOn}
          onToggleAudio={toggleAudio}
          mode={mode}
          onMode={setMode}
          onScan={scanForTargets}
          onStart={startLocate}
          onStop={stopLocate}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// CHANNELS                                                                     //
// --------------------------------------------------------------------------- //
function ChannelsTab({ data }: { data: ChannelsResp | null }) {
  const bands = data?.channels ?? {};
  const present = BAND_ORDER.filter((b) => bands[b]?.length).concat(
    Object.keys(bands).filter((b) => !BAND_ORDER.includes(b) && bands[b]?.length),
  );

  if (present.length === 0) {
    return (
      <Tile title="CHANNEL CONGESTION" led="amber">
        <div className="text-txt-dim">
          {data == null ? "scanning channels…" : "no APs seen yet — a passive iw scan runs each refresh"}
        </div>
      </Tile>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {present.map((b) => (
        <BandCongestion
          key={b}
          band={b}
          slots={bands[b]}
          recommend={data?.least_congested?.[b] ?? null}
        />
      ))}
    </div>
  );
}

function BandCongestion({
  band,
  slots,
  recommend,
}: {
  band: string;
  slots: ChannelSlot[];
  recommend: number | null;
}) {
  const sorted = [...slots].sort((a, b) => a.channel - b.channel);
  const maxCount = Math.max(1, ...sorted.map((s) => s.ap_count));
  return (
    <Tile
      title={bandLabel(band)}
      padded={false}
      led={recommend != null ? "mint" : "violet"}
      headerRight={
        <span className="hud-label text-txt-dim">
          best{" "}
          <span className="text-mint-safe tabular-nums">
            {recommend != null ? `ch ${recommend}` : DASH}
          </span>
        </span>
      }
    >
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">CH</th>
              <th className="hud-label px-3 py-2 text-left">APs</th>
              <th className="hud-label px-3 py-2 text-right">Util</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const best = recommend != null && s.channel === recommend;
              return (
                <tr
                  key={s.channel}
                  className={"border-b border-line-dim/40 " + (best ? "bg-mint-safe/10" : "")}
                >
                  <td className="px-3 py-1 tabular-nums">
                    <span className={best ? "text-mint-safe" : "text-txt-body"}>{s.channel}</span>
                    {best && <span className="ml-1 text-mint-safe text-[0.7rem]">◀ best</span>}
                  </td>
                  <td className="px-3 py-1">
                    <div className="flex items-center gap-2">
                      <Bar ratio={s.ap_count / maxCount} color={best ? "mint" : "violet"} />
                      <span className="text-txt-body tabular-nums w-6 text-right">{s.ap_count}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {s.utilization_pct != null ? (
                      <span className={utilColor(s.utilization_pct)}>
                        {s.utilization_pct.toFixed(0)}%
                      </span>
                    ) : (
                      <span className="text-txt-dim">{DASH}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function utilColor(pct: number): string {
  if (pct >= 70) return "text-pink-alert";
  if (pct >= 40) return "text-amber-base";
  return "text-mint-safe";
}

// Simple horizontal congestion bar (dark-theme native — no external libs).
function Bar({ ratio, color }: { ratio: number; color: "violet" | "mint" }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const fill = color === "mint" ? "var(--mint-safe)" : "var(--violet-base)";
  return (
    <span className="inline-block h-2 w-24 border border-line-dim bg-transparent align-middle">
      <span
        className="block h-full"
        style={{ width: `${pct}%`, background: fill, boxShadow: pct > 0 ? "0 0 6px rgba(157,114,255,0.4)" : undefined }}
      />
    </span>
  );
}

// --------------------------------------------------------------------------- //
// SURVEY (dead-zone walk-test)                                                 //
// --------------------------------------------------------------------------- //
function SurveyTab({
  trace,
  busy,
  onRecord,
  onReset,
}: {
  trace: WalkTrace | null;
  busy: string | null;
  onRecord: () => void;
  onReset: () => void;
}) {
  const sum = trace?.summary;
  const zones = sum?.zones ?? {};
  const samples = trace?.samples ?? [];
  const ZONES: { key: string; label: string }[] = [
    { key: "hot", label: "HOT" },
    { key: "warm", label: "WARM" },
    { key: "cold", label: "COLD" },
    { key: "dead", label: "DEAD" },
  ];

  return (
    <div className="space-y-4">
      <Tile title="WALK-TEST CONTROL" led={busy ? "amber" : "violet"}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusLED color={(sum?.count ?? 0) > 0 ? "cyan" : "dim"} />
            <span className="text-txt-body">
              {(sum?.count ?? 0) > 0
                ? `${sum?.count} samples recorded — walk the space and tag each waypoint`
                : "no samples yet — stand in a spot and record the signal there"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
              onClick={onRecord}
              disabled={busy === "sample"}
            >
              {busy === "sample" ? "⟳ RECORDING…" : `◉ Record sample here (WP-${(sum?.count ?? 0) + 1})`}
            </button>
            <button
              className="hud-btn border-pink-alert text-pink-alert disabled:opacity-40"
              onClick={onReset}
              disabled={busy === "reset" || (sum?.count ?? 0) === 0}
            >
              {busy === "reset" ? "⟳ RESETTING…" : "✕ Reset"}
            </button>
          </div>
          <div className="text-txt-dim text-[0.75rem]">
            Each sample tags the current spot with the associated AP's RSSI (or the strongest match
            from a scan). Zones: <span className="text-mint-safe">hot</span> ≥ −60 ·{" "}
            <span className="text-amber-base">warm</span> ≥ −70 · <span className="text-cyan-signal">cold</span> ≥ −80 ·{" "}
            <span className="text-pink-alert">dead</span> &lt; −80 / none.
          </div>
        </div>
      </Tile>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {ZONES.map((z) => {
          const c = zoneColor(z.key);
          return (
            <Tile key={z.key} title={z.label} led={c === "dim" ? "dim" : c}>
              <BigValue value={zones[z.key] ?? 0} color={c === "dim" ? "dim" : c} size="md" />
              <div className="mt-1 text-txt-dim text-[0.7rem]">samples</div>
            </Tile>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="SAMPLES"><BigValue value={sum?.count ?? 0} color="violet" size="md" /></Tile>
        <Tile title="MIN dBm"><BigValue value={sum?.min_dbm ?? DASH} color="cyan" size="md" /></Tile>
        <Tile title="AVG dBm"><BigValue value={sum?.avg_dbm ?? DASH} color="amber" size="md" /></Tile>
        <Tile title="MAX dBm"><BigValue value={sum?.max_dbm ?? DASH} color="mint" size="md" /></Tile>
      </div>

      <Tile title="WAYPOINT TRACE" padded={false} led={samples.length > 0 ? "cyan" : "amber"}>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">WP</th>
                <th className="hud-label px-3 py-2 text-left">Target</th>
                <th className="hud-label px-3 py-2 text-left">RSSI</th>
                <th className="hud-label px-3 py-2 text-left">Zone</th>
                <th className="hud-label px-3 py-2 text-left">CH</th>
                <th className="hud-label px-3 py-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {samples.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-txt-dim">no samples yet — record one above</td></tr>
              )}
              {samples.slice().reverse().map((s, i) => {
                const c = zoneColor(s.zone);
                return (
                  <tr key={`${s.ts}-${i}`} className="border-b border-line-dim/40">
                    <td className="px-3 py-1 text-txt-body">{s.label || DASH}</td>
                    <td className="px-3 py-1 text-violet-bright break-all">{s.target || DASH}</td>
                    <td className="px-3 py-1 tabular-nums">
                      <span className="inline-flex items-center gap-2">
                        <SignalBars value={s.rssi_dbm} min={-95} max={-30} color={c === "dim" ? "cyan" : c} />
                        <span className={c === "dim" ? "text-txt-dim" : ZONE_TEXT[c]}>
                          {s.rssi_dbm != null ? `${s.rssi_dbm}` : DASH}
                        </span>
                      </span>
                    </td>
                    <td className={"px-3 py-1 uppercase " + ZONE_TEXT[c]}>{s.zone}</td>
                    <td className="px-3 py-1 tabular-nums text-txt-dim">{s.channel ?? DASH}</td>
                    <td className="px-3 py-1 text-right tabular-nums text-txt-dim">
                      {s.ts ? new Date(s.ts * 1000).toLocaleTimeString() : DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tile>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// LOCATE (AP location finder — homing meter)                                   //
// --------------------------------------------------------------------------- //
function LocateTab({
  locate,
  locating,
  scanAps,
  scanBusy,
  locBusy,
  audioOn,
  onToggleAudio,
  onScan,
  onStart,
  onStop,
}: {
  locate: LocateSample | null;
  locating: boolean;
  scanAps: ScanAP[];
  scanBusy: boolean;
  locBusy: string | null;
  audioOn: boolean;
  onToggleAudio: () => void;
  onScan: () => void;
  onStart: (ap: ScanAP) => void;
  onStop: () => void;
}) {
  if (locating) {
    return (
      <HomingMeter
        locate={locate}
        locBusy={locBusy}
        audioOn={audioOn}
        onToggleAudio={onToggleAudio}
        onStop={onStop}
      />
    );
  }
  return (
    <TargetPicker
      scanAps={scanAps}
      scanBusy={scanBusy}
      locBusy={locBusy}
      onScan={onScan}
      onStart={onStart}
    />
  );
}

function TargetPicker({
  scanAps,
  scanBusy,
  locBusy,
  onScan,
  onStart,
}: {
  scanAps: ScanAP[];
  scanBusy: boolean;
  locBusy: string | null;
  onScan: () => void;
  onStart: (ap: ScanAP) => void;
}) {
  return (
    <Tile
      title="PICK A TARGET TO LOCATE"
      padded={false}
      led={scanAps.length > 0 ? "mint" : "amber"}
      headerRight={
        <button
          className="hud-btn px-2 py-0.5 text-[0.72rem] border-cyan-signal text-cyan-signal disabled:opacity-40"
          onClick={onScan}
          disabled={scanBusy}
        >
          {scanBusy ? "⟳ scanning…" : "⟳ Scan for APs"}
        </button>
      }
    >
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">SSID</th>
              <th className="hud-label px-3 py-2 text-left">BSSID</th>
              <th className="hud-label px-3 py-2 text-left">CH</th>
              <th className="hud-label px-3 py-2 text-left">Band</th>
              <th className="hud-label px-3 py-2 text-left">SIG</th>
              <th className="hud-label px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {scanAps.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-txt-dim">
                  {scanBusy ? "scanning…" : "click “Scan for APs” to list nearby access points, then pick one to home in on"}
                </td>
              </tr>
            )}
            {scanAps.slice(0, 200).map((a) => (
              <tr key={a.bssid} className="border-b border-line-dim/40 hover:bg-violet-base/10">
                <td className="px-3 py-1 text-violet-bright">{a.ssid || <span className="text-txt-dim">— hidden</span>}</td>
                <td className="px-3 py-1 text-txt-body tabular-nums">{a.bssid}</td>
                <td className="px-3 py-1 tabular-nums text-txt-body">{a.channel ?? "?"}</td>
                <td className="px-3 py-1 text-txt-dim">{a.band ? `${a.band}` : DASH}</td>
                <td className="px-3 py-1">
                  <span className="inline-flex items-center gap-2">
                    <SignalBars value={a.signal_dbm} min={-95} max={-30} color="cyan" />
                    <span className="text-cyan-signal tabular-nums">{a.signal_dbm ?? DASH}</span>
                  </span>
                </td>
                <td className="px-3 py-1">
                  <button
                    className="hud-btn border-amber-base text-amber-base px-2 py-0.5 text-[0.72rem] disabled:opacity-40"
                    onClick={() => onStart(a)}
                    disabled={locBusy === "start" || a.channel == null}
                    title={a.channel == null ? "no channel known — rescan" : "begin homing on this AP"}
                  >
                    {locBusy === "start" ? "⟳…" : "◎ Locate →"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

const TREND_META: Record<Trend, { label: string; color: ZoneColor; arrow: string }> = {
  warmer: { label: "WARMER", color: "mint", arrow: "▲" },
  colder: { label: "COLDER", color: "pink", arrow: "▼" },
  steady: { label: "STEADY", color: "amber", arrow: "＝" },
  "no-signal": { label: "NO SIGNAL", color: "dim", arrow: "∅" },
};

function HomingMeter({
  locate,
  locBusy,
  audioOn,
  onToggleAudio,
  onStop,
}: {
  locate: LocateSample | null;
  locBusy: string | null;
  audioOn: boolean;
  onToggleAudio: () => void;
  onStop: () => void;
}) {
  const rssi = locate?.rssi_dbm ?? null;
  const trend: Trend = locate?.trend ?? "no-signal";
  const tm = TREND_META[trend] ?? TREND_META["no-signal"];
  const delta = locate?.delta ?? null;
  const peak = locate?.peak_dbm ?? null;
  const peakAgo = locate?.peak_ago_s ?? null;
  const rate = locate?.rate_hz ?? 0;
  const range = locate?.est_range_ft ?? null;
  const proximity = locate?.proximity ?? "no-signal";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Primary readout — big dBm + signal bar + geiger audio toggle */}
        <Tile
          title="SIGNAL"
          led={rssi != null ? "cyan" : "amber"}
          className="lg:col-span-1"
          headerRight={
            <button
              className="hud-btn px-2 py-0.5 text-[0.72rem]"
              data-active={audioOn ? "true" : undefined}
              onClick={onToggleAudio}
              title={
                audioOn
                  ? "Geiger audio ON — ticks speed up as you get closer; click to mute"
                  : "muted — click to enable Geiger homing ticks"
              }
              aria-pressed={audioOn}
            >
              {audioOn ? "🔊 Geiger" : "🔇 Muted"}
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            <BigValue value={rssi != null ? rssi : DASH} unit="dBm" color="cyan" size="xl" flashOnChange />
            <SignalBars value={rssi} min={-95} max={-30} bars={12} color="cyan" className="h-6" />
            <div className="text-txt-dim text-[0.75rem] tabular-nums">
              {rate} beacons/s{locate?.raw_dbm != null ? ` · raw ${locate.raw_dbm} dBm` : ""}
            </div>
          </div>
        </Tile>

        {/* Trend — the heart of the fox-hunt */}
        <Tile title="TREND" led={tm.color === "dim" ? "dim" : tm.color} className="lg:col-span-1">
          <div className="flex flex-col items-center justify-center gap-2 py-2">
            <div className={"text-[3rem] leading-none " + ZONE_TEXT[tm.color]}>{tm.arrow}</div>
            <div className={"text-[1.5rem] font-semibold tracking-tight " + ZONE_TEXT[tm.color]}>
              {tm.label}
            </div>
            <div className="text-txt-dim text-[0.8rem] tabular-nums">
              {delta != null ? `${delta > 0 ? "+" : ""}${delta} dB` : "—"} over last samples
            </div>
          </div>
        </Tile>

        {/* Proximity + peak-hold + coarse range */}
        <Tile title="PROXIMITY" led={proximity !== "no-signal" ? "violet" : "dim"} className="lg:col-span-1">
          <div className="space-y-2">
            <BigValue value={proximity.toUpperCase()} color="violet" size="md" />
            <Field k="Peak" v={peak != null ? `${peak} dBm` : DASH} />
            <Field k="Peak age" v={peakAgo != null ? `${peakAgo}s ago` : DASH} />
            <Field
              k="Range"
              v={range != null ? `~${range} ft` : DASH}
            />
            <div className="text-txt-dim text-[0.68rem]">
              range is approximate — unreliable indoors (walls/multipath). Trust the trend, not the feet.
            </div>
          </div>
        </Tile>
      </div>

      <Tile title="TARGET" led="cyan">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid grid-cols-1 gap-1 text-[0.85rem] md:grid-cols-3 md:gap-x-6">
            <Field k="SSID" v={locate?.ssid || DASH} />
            <Field k="BSSID" v={locate?.bssid || DASH} />
            <Field k="Channel" v={locate?.channel ?? DASH} />
          </div>
          <button
            className="hud-btn border-pink-alert text-pink-alert disabled:opacity-40"
            onClick={onStop}
            disabled={locBusy === "stop"}
          >
            {locBusy === "stop" ? "⟳ STOPPING…" : "■ STOP"}
          </button>
        </div>
      </Tile>
    </div>
  );
}

function Field({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="hud-label text-txt-dim">{k}</span>
      <span className="text-right break-all text-txt-body tabular-nums">{v}</span>
    </div>
  );
}
