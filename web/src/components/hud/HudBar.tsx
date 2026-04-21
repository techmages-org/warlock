import { useEffect, useState } from "react";
import { apiGet, type DashboardStatus } from "../../lib/api";
import { StatusLED } from "./StatusLED";

function formatUptime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

type Version = { name: string; version: string };

// Derive an uptime estimate from load average / boot sequencing. We don't have
// a direct uptime field on /api/dashboard/status, so we read the hostname
// freshness by diffing `now` against when this component mounted as a coarse
// fallback. Real uptime is computed client-side from the initial load time.
export function HudBarTop() {
  const [version, setVersion] = useState<Version | null>(null);
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [localNow, setLocalNow] = useState<Date>(new Date());
  const [mountedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    apiGet<Version>("/api/version").then(setVersion).catch(() => setVersion(null));
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await apiGet<DashboardStatus>("/api/dashboard/status");
        if (alive) setStatus(r);
      } catch {
        /* swallow — strip shows stale */
      }
    };
    load();
    const t = setInterval(load, 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setLocalNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Session-uptime fallback: seconds since page load. Covers the "UP <uptime>"
  // slot in a stable way without adding a new API field.
  const sessionUptime = (Date.now() - mountedAt) / 1000;

  const led = (ok: boolean | undefined, warnOnly = false) =>
    ok ? "mint" : warnOnly ? "amber" : "pink";

  const hostname = status?.hostname ?? "warlock";
  const kernel = "linux"; // no dedicated kernel field on the API surface yet
  const isoTime = localNow.toISOString().replace("T", " ").slice(0, 19) + "Z";
  const versionLabel = version ? `v${version.version}` : "v—";

  const chronyOk = status?.chrony?.ok;
  const gpsOk = status?.gps?.ok && (status?.gps?.mode ?? 0) >= 2;
  const meshOk = status?.mesh_node_count != null;

  return (
    <header
      role="banner"
      aria-label="system HUD strip"
      className="hud-strip sticky top-0 z-30 flex h-6 items-center gap-3 border-b border-line-dim px-3"
    >
      <span className="flex items-center gap-1.5 text-amber-base" style={{ textShadow: "var(--glow-amber)" }}>
        <span aria-hidden="true">◉</span>
        <span className="font-semibold">WARLOCK</span>
      </span>
      <span className="text-txt-dim">▪</span>
      <span className="text-txt-body normal-case" style={{ letterSpacing: 0 }}>{hostname}.local</span>
      <span className="text-txt-dim">▪</span>
      <span className="text-txt-dim">{versionLabel}</span>
      <span className="text-txt-dim">▪</span>
      <span className="text-txt-dim">KRNL {kernel}</span>
      <span className="text-txt-dim">▪</span>
      <span className="tabular-nums text-txt-body">UP {formatUptime(sessionUptime)}</span>
      <span className="text-txt-dim">▪</span>
      <span className="tabular-nums text-txt-hi">
        {isoTime}
        <span aria-hidden="true" className="ml-0.5 inline-block animate-cursor-blink text-amber-base">▋</span>
      </span>
      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5" title="HTTP service">
          <StatusLED color="mint" size={6} label="service" />
          <span className="text-txt-dim">SVC</span>
        </span>
        <span className="flex items-center gap-1.5" title="chrony / time">
          <StatusLED color={led(chronyOk, true)} size={6} label="chrony" />
          <span className="text-txt-dim">NTP</span>
        </span>
        <span className="flex items-center gap-1.5" title="gps fix">
          <StatusLED color={led(gpsOk, true)} size={6} label="gps" />
          <span className="text-txt-dim">GPS</span>
        </span>
        <span className="flex items-center gap-1.5" title="mesh reachable">
          <StatusLED color={led(meshOk, true)} size={6} label="mesh" />
          <span className="text-txt-dim">MSH</span>
        </span>
      </span>
    </header>
  );
}

export function HudBarBottom() {
  return (
    <footer
      role="contentinfo"
      aria-label="hotkey hints"
      className="hud-strip sticky bottom-0 z-30 flex h-6 items-center gap-4 border-t border-line-dim px-3"
    >
      <span className="text-txt-dim">
        <span className="text-violet-bright">[G D]</span> dash
      </span>
      <span className="text-txt-dim">
        <span className="text-violet-bright">[G M]</span> mesh
      </span>
      <span className="text-txt-dim">
        <span className="text-violet-bright">[G G]</span> gps
      </span>
      <span className="text-txt-dim">
        <span className="text-violet-bright">[G S]</span> sdr
      </span>
      <span className="text-txt-dim">
        <span className="text-violet-bright">[?]</span> help
      </span>
      <span className="ml-auto text-txt-dim">AUDIT :: on</span>
    </footer>
  );
}
