import { useEffect, useState } from "react";
import { apiGet, apiPost, type EngagementStatus } from "../../lib/api";
import { openEventBus } from "../../lib/ws";

function elapsedSince(iso: string | null): string {
  if (!iso) return "0:00";
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return "0:00";
  const d = Math.max(0, (Date.now() - start) / 1000);
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  const s = Math.floor(d % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function EngagementBanner() {
  const [status, setStatus] = useState<EngagementStatus>({
    mode: "loading",
    engagement_id: null,
    name: "",
    scope: { ssids: [], bssids: [], ip_ranges: [] },
    started_at: null,
  });
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const s = await apiGet<EngagementStatus>("/api/engagements/active");
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus((p) => ({ ...p, mode: "loading" }));
      }
    };
    refresh();
    const t = setInterval(refresh, 2000);
    const stop = openEventBus((e) => {
      if (e.name.startsWith("engagement.") || e.name === "killswitch.pressed") refresh();
    });
    return () => { alive = false; clearInterval(t); stop(); };
  }, []);

  // Tick the elapsed timer once a second without thrashing `status`.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const killswitch = async () => {
    setBusy(true);
    try {
      await apiPost("/api/engagements/killswitch");
    } finally {
      setBusy(false);
    }
  };

  if (status.mode === "loading") {
    return (
      <div className="relative flex h-8 items-center justify-between border-b border-line-dim bg-bg-strip px-3 text-[0.6875rem] uppercase tracking-label text-amber-base">
        <span>◎ acquiring engagement state…</span>
      </div>
    );
  }

  if (status.mode === "off") {
    return (
      <div className="relative flex h-8 items-center justify-between border-b border-line-dim bg-bg-strip px-3 text-[0.6875rem] uppercase tracking-label text-mint-safe">
        <span className="flex items-center gap-2">
          <span aria-hidden="true">◎</span>
          <span>SAFE MODE — passive instruments only</span>
        </span>
        <span className="text-txt-dim">no engagement active</span>
      </div>
    );
  }

  // Engaged state — 48px band with animated scanline, elapsed counter, scope.
  const scopeCount =
    status.scope.ssids.length + status.scope.bssids.length + status.scope.ip_ranges.length;
  // tick read so the linter sees we depend on it
  void tick;
  return (
    <div
      role="alert"
      aria-live="polite"
      className="is-engaged relative flex h-12 items-center justify-between overflow-hidden border-b border-pink-alert/70 px-4"
      style={{
        background:
          "linear-gradient(90deg, rgba(255,41,117,0.38) 0%, rgba(167,139,250,0.32) 100%)",
        boxShadow: "inset 0 0 40px rgba(255,41,117,0.25)",
      }}
    >
      <div className="engagement-scanline" />
      <div className="relative flex items-center gap-3 text-[0.9375rem] font-semibold uppercase tracking-label text-white">
        <span aria-hidden="true" className="text-pink-alert" style={{ textShadow: "var(--glow-pink)" }}>
          ▶▶▶
        </span>
        <span>ENGAGED</span>
        <span className="text-white/60">::</span>
        <span className="text-amber-bright" style={{ textShadow: "var(--glow-amber)" }}>
          {status.name || status.engagement_id || "unnamed"}
        </span>
        <span className="text-white/60">::</span>
        <span className="tabular-nums">T+{elapsedSince(status.started_at)}</span>
        <span className="text-white/60">::</span>
        <span>SCOPE {scopeCount} target{scopeCount === 1 ? "" : "s"}</span>
        <span aria-hidden="true" className="text-pink-alert" style={{ textShadow: "var(--glow-pink)" }}>
          ◀◀◀
        </span>
      </div>
      <button
        className="hud-btn hud-btn-danger relative z-10"
        disabled={busy}
        onClick={killswitch}
      >
        {busy ? "…" : "KILL SWITCH"}
      </button>
    </div>
  );
}
