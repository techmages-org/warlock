import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { openEventBus } from "../lib/ws";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";

// ---------------------------------------------------------------------------
// Offensive SDR — RF capture / analyze / replay console.
//
// Doctrine (02-warlock-command-center.md §Module 8): RTL-SDR is RX-only, so the
// deck can *capture* IQ and *analyze* signals (garage / TPMS / 433 MHz) freely,
// and *prepare* replay files — but actually re-transmitting needs a HackRF /
// LimeSDR. We therefore treat REPLAY as RF-emitting and hard-gate it:
//   • capture  — engagement-gated server-side (backend 403s without one) → we
//                disable + CTA when no engagement is active.
//   • analyze  — passive, always available.
//   • replay   — engagement-gated AND requires an explicit two-step
//                confirm-before-fire in the UI (it may key a transmitter).
//
// Every field read off the status payload is optional and degrades to "—", so
// this page renders as a real instrument whether the backend returns the old
// stub shape or the enriched Phase-3 contract. Source-additive: no other page
// or endpoint changes.
// ---------------------------------------------------------------------------

type Capture = {
  id?: string | null;
  name?: string | null;
  filename?: string | null;
  path?: string | null;
  freq_mhz?: number | null; // canonical frequency field (MHz) — display + bodies
  freq_hz?: number | null;  // defensive: derive MHz from this if a row exposes Hz
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
  message?: string | null;
  audit_id?: string | null;
  error?: string | null;
  ts?: string | number | null;
} | null;

// Permissive: backend may still be on the old stub shape mid-parallel-build.
type SdrOffStatus = {
  module?: string;
  label?: string;
  status?: string;
  requires_engagement?: boolean;
  todo?: string[];
  // --- enriched (all optional) ---
  ok?: boolean;
  rx_device?: string | null;
  tx_device?: string | null;
  tx_capable?: boolean | null;
  busy?: boolean | null;
  reason?: string | null;
  captures?: Capture[];
  last_result?: OpResult;
};

// Subset of /api/ops/status — the canonical engagement gate the web app uses
// (mirrors Wireless.tsx). engaged === mode "on".
type EngStatus = {
  mode: "on" | "off" | string;
  engagement_id: string | null;
  name: string;
  scope: { ssids: string[]; bssids: string[]; ip_ranges: string[] };
};

const DASH = "—";

const SAMPLE_RATES: { v: number; l: string }[] = [
  { v: 250_000, l: "250 kS/s" },
  { v: 1_000_000, l: "1.0 MS/s" },
  { v: 2_000_000, l: "2.0 MS/s" },
  { v: 2_048_000, l: "2.048 MS/s" },
  { v: 2_400_000, l: "2.4 MS/s" },
];

// be-p3's capture/replay/analyze bodies key off the FILENAME, not an id.
function capFile(c: Capture): string {
  return c.filename || c.name || c.id || c.path || "";
}
// React list key — id is the most stable when present.
function capKey(c: Capture): string {
  return c.id || c.filename || c.name || c.path || "";
}
function capLabel(c: Capture): string {
  return c.filename || c.name || c.id || c.path || "capture";
}
// Resolve a capture's frequency in MHz for the action bodies. Prefer the
// freq_mhz field, else convert a freq_hz the row may expose.
function capFreqMhz(c: Capture): number | undefined {
  if (c.freq_mhz != null && Number.isFinite(c.freq_mhz)) return c.freq_mhz;
  if (c.freq_hz != null && Number.isFinite(c.freq_hz)) return c.freq_hz / 1e6;
  return undefined;
}
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return DASH;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtNum(n: number | null | undefined, unit = ""): string {
  if (n == null || Number.isNaN(n)) return DASH;
  return unit ? `${n.toLocaleString()} ${unit}` : n.toLocaleString();
}

export function SdrOffensive() {
  const [status, setStatus] = useState<SdrOffStatus | null>(null);
  const [eng, setEng] = useState<EngStatus | null>(null);
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingReplay, setPendingReplay] = useState<Capture | null>(null);

  // capture form
  const [freqMhz, setFreqMhz] = useState<string>("433.92");
  const [durationS, setDurationS] = useState<string>("5");
  const [sampleRate, setSampleRate] = useState<number>(2_000_000);

  const engaged = eng?.mode === "on";

  const refresh = useCallback(async () => {
    try { setStatus(await apiGet<SdrOffStatus>("/api/sdr_offensive/status")); } catch { /**/ }
    try { setEng(await apiGet<EngStatus>("/api/ops/status")); } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  // Live: backend pushes sdr.status over the bus — re-pull canonical status so we
  // stay correct regardless of the event payload shape. Polling above remains a
  // resilient fallback if events never arrive.
  useEffect(() => {
    const stop = openEventBus((e) => {
      if (e.name === "sdr.status" || e.name.startsWith("engagement.") || e.name === "killswitch.pressed") {
        refresh();
      }
    });
    return stop;
  }, [refresh]);

  const captures = useMemo<Capture[]>(
    () => (Array.isArray(status?.captures) ? (status!.captures as Capture[]) : []),
    [status],
  );

  const txCapable = status?.tx_capable === true;
  const rxDevice = status?.rx_device ?? null;
  const txDevice = status?.tx_device ?? null;
  const serverBusy = status?.busy === true;

  const stateLabel =
    status == null ? "ACQUIRING" : serverBusy ? "BUSY" : engaged ? "ARMED" : "SAFE";

  // --- ops -----------------------------------------------------------------
  const explain403 = (op: string) =>
    engaged
      ? `${op} refused (403) — target is not in the active engagement scope. Adjust scope on Operations.`
      : `${op} refused (403) — no active engagement. Activate one on Operations first.`;

  const post = useCallback(
    async (op: string, path: string, body: Record<string, unknown>) => {
      setBusy(op);
      try {
        const d = await apiPost<OpResult>(path, body);
        const msg = d?.detail || d?.message || (d?.ok === false ? d?.error || "failed" : "ok");
        setNote(`${op}: ${msg}${d?.audit_id ? ` · audit ${String(d.audit_id).slice(0, 8)}` : ""}`);
        await refresh();
      } catch (e) {
        const m = String(e);
        setNote(m.includes("403") ? explain403(op) : `${op} failed: ${m}`);
      } finally {
        setBusy(null);
      }
    },
    [refresh, engaged],
  );

  const onCapture = () => {
    const mhz = Number(freqMhz);
    const dur = Number(durationS);
    if (!Number.isFinite(mhz) || mhz <= 0) { setNote("capture: enter a valid frequency in MHz"); return; }
    if (!Number.isFinite(dur) || dur < 1 || dur > 300) {
      setNote("capture: duration must be 1–300 s"); return;
    }
    // be-p3 CaptureBody: freq_mhz (MHz — backend converts), sample_rate, duration_s (int).
    post("capture", "/api/sdr_offensive/capture", {
      freq_mhz: mhz,
      sample_rate: sampleRate,
      duration_s: Math.round(dur),
    });
  };

  // be-p3 AnalyzeBody: { capture: <filename> } — passive, no path field.
  const onAnalyze = (c: Capture) =>
    post("analyze", "/api/sdr_offensive/analyze", { capture: capFile(c) });

  // be-p3 ReplayBody (RF): { capture:<filename>, freq_mhz, sample_rate, tx_gain, target(required) }.
  const confirmReplay = (c: Capture, target: string, txGain: number) => {
    setPendingReplay(null);
    post("replay", "/api/sdr_offensive/replay", {
      capture: capFile(c),
      freq_mhz: capFreqMhz(c),
      sample_rate: c.sample_rate ?? 2_000_000,
      tx_gain: txGain,
      target,
    });
  };

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="09 SDR-OFF"
        title="Offensive SDR — RF capture · analyze · replay"
        state={stateLabel}
        icon="☢"
        right={
          <span className="hud-label text-txt-dim">
            rx:{rxDevice ?? DASH} · tx:{txDevice ?? (txCapable ? "ready" : "none")} ·{" "}
            <span className={engaged ? "text-pink-alert" : "text-mint-safe"}>
              {engaged ? "ENGAGED" : "SAFE"}
            </span>
          </span>
        }
      />

      {/* Engagement gate banner — shared pattern with Wireless ACT. */}
      <EngagementGate engaged={engaged} eng={eng} />

      {note && (
        <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>
      )}

      {/* Status tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="RX DEVICE" led={rxDevice ? "mint" : "amber"}>
          <BigValue value={rxDevice ?? DASH} color={rxDevice ? "mint" : "amber"} size="md" />
          <div className="mt-2 text-txt-dim text-[0.75rem]">RTL-SDR · receive-only</div>
        </Tile>
        <Tile title="TX CHAIN" led={txCapable ? "mint" : "pink"}>
          <BigValue
            value={txCapable ? "READY" : "NONE"}
            color={txCapable ? "mint" : "pink"}
            size="md"
          />
          <div className="mt-2 text-txt-dim text-[0.75rem]">
            {txCapable ? txDevice ?? "HackRF / LimeSDR" : "no transmitter — replay prepares files only"}
          </div>
        </Tile>
        <Tile title="ENGINE" led={serverBusy ? "amber" : "violet"}>
          <div className="flex items-center gap-2">
            <StatusLED color={serverBusy ? "amber" : "dim"} />
            <span className="text-txt-body">{serverBusy ? "operation running" : "idle"}</span>
          </div>
          <div className="mt-2 text-txt-dim text-[0.75rem]">
            status: {status?.status ?? (status?.ok != null ? (status.ok ? "ok" : "error") : DASH)}
          </div>
        </Tile>
        <Tile title="CAPTURES" led={captures.length > 0 ? "mint" : "amber"}>
          <BigValue value={captures.length} color="cyan" size="md" />
          <div className="mt-2 text-txt-dim text-[0.75rem]">IQ files on deck</div>
        </Tile>
      </div>

      {/* CAPTURE — engagement-gated server-side; disable + explain when off. */}
      <Tile title="CAPTURE IQ" led={engaged ? "violet" : "amber"}>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="block">
              <span className="hud-label block mb-1">Frequency (MHz)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.001"
                value={freqMhz}
                onChange={(e) => setFreqMhz(e.target.value)}
                className="hud-input w-full tabular-nums"
              />
              <span className="text-txt-dim text-[0.68rem]">MHz · e.g. 433.92</span>
            </label>
            <label className="block">
              <span className="hud-label block mb-1">Duration (s)</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min="1"
                max="300"
                value={durationS}
                onChange={(e) => setDurationS(e.target.value)}
                className="hud-input w-full tabular-nums"
              />
              <span className="text-txt-dim text-[0.68rem]">1 – 300 s</span>
            </label>
            <label className="block">
              <span className="hud-label block mb-1">Sample rate</span>
              <select
                value={sampleRate}
                onChange={(e) => setSampleRate(Number(e.target.value))}
                className="hud-input w-full"
              >
                {SAMPLE_RATES.map((s) => (
                  <option key={s.v} value={s.v}>{s.l}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
              onClick={onCapture}
              disabled={!engaged || busy === "capture" || serverBusy}
              title={engaged ? "record IQ to ~/warlock/captures/iq/" : "requires an active engagement"}
            >
              {busy === "capture" ? "⟳ CAPTURING…" : "● CAPTURE IQ"}
            </button>
            <span className="text-txt-dim text-[0.75rem]">
              Records raw IQ to <code className="text-violet-bright">~/warlock/captures/iq/</code>.
              {!engaged && " Engagement-gated — activate an engagement to enable."}
            </span>
          </div>
        </div>
      </Tile>

      {/* CAPTURES — analyze (passive) / replay (RF, gated + confirm). */}
      <Tile title="CAPTURED SIGNALS" padded={false} led={captures.length > 0 ? "mint" : "amber"}>
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">File</th>
                <th className="hud-label px-3 py-2 text-right">Freq</th>
                <th className="hud-label px-3 py-2 text-right">Rate</th>
                <th className="hud-label px-3 py-2 text-right">Dur</th>
                <th className="hud-label px-3 py-2 text-right">Size</th>
                <th className="hud-label px-3 py-2 text-left">Demod</th>
                <th className="hud-label px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {captures.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-txt-dim">
                    no captures yet — record IQ above (garage / TPMS / 433 MHz), then analyze or replay
                  </td>
                </tr>
              )}
              {captures.map((c) => {
                const key = capKey(c);
                return (
                  <tr key={key || capLabel(c)} className="border-b border-line-dim/40">
                    <td className="px-3 py-1 text-txt-body break-all">{capLabel(c)}</td>
                    <td className="px-3 py-1 text-right tabular-nums text-amber-base">
                      {fmtNum(c.freq_mhz ?? (c.freq_hz != null ? c.freq_hz / 1e6 : null), "MHz")}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-txt-dim">
                      {c.sample_rate != null ? `${(c.sample_rate / 1e6).toFixed(3)} MS/s` : DASH}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-txt-dim">
                      {c.duration_s != null ? `${c.duration_s}s` : DASH}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-txt-dim">
                      {fmtBytes(c.size_bytes)}
                    </td>
                    <td className="px-3 py-1 text-cyan-signal">{c.modulation ?? DASH}</td>
                    <td className="px-3 py-1">
                      <div className="flex flex-wrap gap-1">
                        <button
                          className="hud-btn border-cyan-signal text-cyan-signal px-2 py-0.5 text-[0.72rem] disabled:opacity-40"
                          onClick={() => onAnalyze(c)}
                          disabled={busy === "analyze"}
                          title="passive demodulation / signal analysis"
                        >
                          {busy === "analyze" ? "⟳…" : "⌕ Analyze"}
                        </button>
                        <button
                          className="hud-btn border-pink-alert text-pink-alert px-2 py-0.5 text-[0.72rem] disabled:opacity-40"
                          onClick={() => setPendingReplay(c)}
                          disabled={!engaged || busy === "replay" || serverBusy}
                          title={
                            engaged
                              ? "RF-emitting — requires confirmation"
                              : "engagement-gated — RF replay needs an active engagement"
                          }
                        >
                          {busy === "replay" ? "⟳…" : "⚡ Replay"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tile>

      {/* LAST OPERATION — audit feedback. */}
      {status?.last_result && (
        <Tile
          title="LAST OPERATION"
          led={status.last_result.ok === false ? "pink" : "mint"}
        >
          <div className="grid grid-cols-1 gap-1 text-[0.8125rem] md:grid-cols-2">
            <Field k="Op" v={status.last_result.op ?? DASH} />
            <Field
              k="Result"
              v={status.last_result.ok === false ? "FAILED" : status.last_result.ok ? "OK" : DASH}
              color={status.last_result.ok === false ? "text-pink-alert" : "text-mint-safe"}
            />
            <Field
              k="Detail"
              v={status.last_result.detail || status.last_result.message || status.last_result.error || DASH}
            />
            <Field k="Audit" v={status.last_result.audit_id ?? DASH} />
            <Field k="When" v={status.last_result.ts != null ? String(status.last_result.ts) : DASH} />
          </div>
        </Tile>
      )}

      {/* Confirm-before-fire modal for RF replay. */}
      {pendingReplay && (
        <ReplayConfirm
          capture={pendingReplay}
          txCapable={txCapable}
          eng={eng}
          onCancel={() => setPendingReplay(null)}
          onConfirm={(target, txGain) => confirmReplay(pendingReplay, target, txGain)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Engagement gate banner                                                       //
// --------------------------------------------------------------------------- //
function EngagementGate({ engaged, eng }: { engaged: boolean; eng: EngStatus | null }) {
  if (!engaged) {
    return (
      <div className="hud-tile border-pink-alert px-3 py-3 text-pink-alert flex flex-wrap items-center gap-3">
        <StatusLED color="pink" />
        <span className="flex-1">
          <b>RF operations are engagement-gated.</b> Capture and replay are refused (403) until an
          engagement is active and the target is in scope. Replay additionally emits RF and requires
          an explicit confirmation.
        </span>
        <Link to="/ops" className="hud-btn border-cyan-signal text-cyan-signal whitespace-nowrap">
          ◆ Go to Operations →
        </Link>
      </div>
    );
  }
  return (
    <div className="hud-tile border-mint-safe px-3 py-2 text-mint-safe flex items-center gap-2">
      <StatusLED color="mint" />
      <span>
        engagement active{eng?.name ? ` — ${eng.name}` : ""}. In-scope capture/replay will run; an
        out-of-scope target is still refused (403). RF replay still needs explicit confirmation.
      </span>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Replay confirm-before-fire                                                   //
// --------------------------------------------------------------------------- //
function ReplayConfirm({
  capture,
  txCapable,
  eng,
  onCancel,
  onConfirm,
}: {
  capture: Capture;
  txCapable: boolean;
  eng: EngStatus | null;
  onCancel: () => void;
  onConfirm: (target: string, txGain: number) => void;
}) {
  // In-scope authorization labels, flattened from the active engagement scope.
  // The backend requires a non-empty `target`; pre-filling from scope guarantees
  // the operator fires against something the engagement actually authorizes.
  const scopeEntries = useMemo(() => {
    const s = eng?.scope;
    if (!s) return [] as string[];
    return [...(s.ssids ?? []), ...(s.bssids ?? []), ...(s.ip_ranges ?? [])]
      .map((x) => String(x).trim())
      .filter((x) => x.length > 0);
  }, [eng]);

  const [target, setTarget] = useState<string>(scopeEntries[0] ?? "");
  const [gain, setGain] = useState<string>("0");

  const engaged = eng?.mode === "on";
  const gainNum = Math.max(0, Math.min(47, Math.round(Number(gain) || 0)));
  const canFire = target.trim().length > 0;
  const mhz = capture.freq_mhz ?? (capture.freq_hz != null ? capture.freq_hz / 1e6 : null);

  // Focus the dialog itself on open (once) so the y/f hotkey is armed
  // immediately and focus lives inside the modal (ESC + a11y). We deliberately
  // do NOT auto-focus the target input — that would disarm the hotkey until blur.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);

  // Key handling: ESC cancels; `y`/`f` fire CONFIRM TRANSMIT (RF-confirm hotkey,
  // parity with the other surfaces) — but ONLY when (a) an engagement is active,
  // (b) a target is set, and (c) the operator is NOT typing in a form field, so a
  // target/gain value containing y/f can never auto-fire. Re-subscribes as those
  // values change so the closure always reads fresh state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCancel(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "y" && k !== "f") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!engaged || !canFire) return;
      e.preventDefault();
      onConfirm(target.trim(), gainNum);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm, engaged, canFire, target, gainNum]);

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="confirm RF replay"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="hud-tile relative w-full max-w-md border-pink-alert p-5 focus:outline-none"
        style={{ boxShadow: "0 0 32px rgba(255,41,117,0.35)" }}
      >
        <div className="flex items-center gap-2 text-pink-alert text-[0.95rem] font-semibold uppercase tracking-label">
          <span aria-hidden="true">⚠</span>
          <span>Confirm RF replay</span>
        </div>
        <div className="mt-3 space-y-2 text-txt-body text-[0.85rem]">
          <p>
            You are about to <b className="text-pink-alert">transmit / replay</b> a captured signal.
            This emits RF and is only lawful within your authorized engagement scope and licensing.
          </p>
          <div className="hud-tile border-line-dim px-3 py-2 text-[0.8rem]">
            <Field k="Capture" v={capLabel(capture)} />
            <Field k="Frequency" v={fmtNum(mhz, "MHz")} />
            <Field
              k="Transmitter"
              v={txCapable ? "present — WILL TRANSMIT" : "none — prepares replay file only"}
              color={txCapable ? "text-pink-alert" : "text-amber-base"}
            />
          </div>

          {/* REQUIRED in-scope target — authorizes the RF emission. */}
          <label className="block">
            <span className="hud-label block mb-1 text-pink-alert">
              Authorized target <span aria-hidden="true">*</span>
            </span>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="in-scope identifier (SSID / BSSID / IP / label)"
              className="hud-input w-full"
            />
            <span className="text-txt-dim text-[0.68rem]">
              RF replay requires an authorized in-scope target.
            </span>
            {scopeEntries.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {scopeEntries.slice(0, 8).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setTarget(s)}
                    className="hud-btn px-2 py-0.5 text-[0.68rem] border-cyan-signal text-cyan-signal"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </label>

          {/* Optional TX gain (0–47 dB). */}
          <label className="block">
            <span className="hud-label block mb-1">TX gain (dB)</span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              max="47"
              value={gain}
              onChange={(e) => setGain(e.target.value)}
              className="hud-input w-28 tabular-nums"
            />
            <span className="ml-2 text-txt-dim text-[0.68rem]">0 – 47</span>
          </label>

          {txCapable && (
            <p className="text-pink-alert text-[0.78rem]">
              A TX-capable device is attached — confirming will key the transmitter.
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="hud-btn border-line-dim text-txt-body"
            onClick={onCancel}
          >
            ✕ Cancel
          </button>
          <button
            className="hud-btn hud-btn-danger border-pink-alert text-pink-alert disabled:opacity-40"
            onClick={() => onConfirm(target.trim(), gainNum)}
            disabled={!canFire}
            title={canFire ? "or press y / f (when not editing a field)" : "enter an authorized in-scope target first"}
          >
            ⚠ CONFIRM TRANSMIT <span className="opacity-60">· y / f</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ k, v, color }: { k: string; v: ReactNode; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="hud-label text-txt-dim">{k}</span>
      <span className={`text-right break-all ${color ?? "text-txt-body"}`}>{v}</span>
    </div>
  );
}
