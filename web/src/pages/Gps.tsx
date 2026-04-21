import { useEffect, useRef, useState, useCallback } from "react";
import { apiGet, apiPost } from "../lib/api";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type FixResp = {
  ok: boolean;
  connected?: boolean;
  mode?: number;
  waiting?: string | null;
  reason?: string;
  lat?: number;
  lon?: number;
  alt?: number;
  speed_mps?: number;
  track_deg?: number;
  climb_mps?: number;
  time?: string;
  hdop?: number;
  vdop?: number;
  pdop?: number;
  satellites_seen?: number;
  satellites_used?: number;
};

type Sat = {
  prn?: number;
  constellation?: string;
  elevation?: number;
  azimuth?: number;
  snr?: number;
  used?: boolean;
};

type SatsResp = { ok: boolean; reason?: string; satellites?: Sat[]; used?: number; seen?: number };

type TimeResp = {
  ok: boolean;
  tracking?: {
    ok?: boolean;
    stratum?: number;
    reference_id?: string;
    last_offset_s?: number;
    rms_offset_s?: number;
    frequency_ppm?: number;
  };
  refclocks?: Array<{ source: string; stratum: number; reach_octal: string; last_rx: string; last_sample: string }>;
  pps?: { present?: boolean; pulsing?: boolean | null; device?: string };
};

type TrackRow = {
  filename: string;
  size_bytes: number;
  points: number;
  started_at?: string | null;
  ended_at?: string | null;
  duration_s?: number | null;
};

type TracksResp = {
  ok: boolean;
  tracks: TrackRow[];
  recording: { active: boolean; filename?: string | null; points?: number; started_at?: string | null };
};

type Tab = "position" | "map" | "sats" | "tracks";

const TABS: { id: Tab; label: string }[] = [
  { id: "position", label: "Position" },
  { id: "map", label: "Map" },
  { id: "sats", label: "Sat View" },
  { id: "tracks", label: "Tracks" },
];

export function Gps() {
  const [tab, setTab] = useState<Tab>("position");
  const [fix, setFix] = useState<FixResp | null>(null);
  const [sats, setSats] = useState<SatsResp | null>(null);
  const [timeStatus, setTimeStatus] = useState<TimeResp | null>(null);
  const [tracks, setTracks] = useState<TracksResp | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([apiGet<FixResp>("/api/gps/fix"), apiGet<SatsResp>("/api/gps/sats")]);
      setFix(f);
      setSats(s);
    } catch {/* swallow — UI shows stale last */}
  }, []);

  useEffect(() => {
    let alive = true;
    refresh();
    const id = setInterval(() => { if (alive) refresh(); }, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [refresh]);

  useEffect(() => {
    if (tab !== "tracks" && tab !== "position") return;
    let alive = true;
    const load = async () => {
      try {
        const t = await apiGet<TracksResp>("/api/gps/tracks");
        if (alive) setTracks(t);
      } catch {/**/ }
    };
    load();
    const id = setInterval(() => { if (alive) load(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "position") return;
    let alive = true;
    const load = async () => { try { const t = await apiGet<TimeResp>("/api/gps/time"); if (alive) setTimeStatus(t); } catch { /**/ } };
    load();
    const id = setInterval(() => { if (alive) load(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  return (
    <div>
      <h1 className="text-lg font-bold mb-3">GPS <span className="text-warlock-muted text-sm">· ublox via gpsd</span></h1>
      <div className="flex gap-1 mb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "wl-btn " +
              (tab === t.id ? "border-warlock-accent text-warlock-accent" : "")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "position" && <PositionTab fix={fix} time={timeStatus} />}
      {tab === "map" && <MapTab fix={fix} recording={tracks?.recording?.active ?? false} />}
      {tab === "sats" && <SatsTab sats={sats} />}
      {tab === "tracks" && <TracksTab data={tracks} reload={() => apiGet<TracksResp>("/api/gps/tracks").then(setTracks).catch(() => {})} />}
    </div>
  );
}

function WaitingBanner({ fix }: { fix: FixResp | null }) {
  if (!fix) return <div className="wl-card mb-3">loading…</div>;
  if (!fix.ok) return <div className="wl-card mb-3 border-warlock-warn text-warlock-warn">gpsd: {fix.reason}</div>;
  if ((fix.mode ?? 0) < 2) return <div className="wl-card mb-3 border-warlock-warn text-warlock-warn">⚠ waiting for fix — {fix.waiting ?? "no sky view yet"}</div>;
  return <div className="wl-card mb-3 border-warlock-accent text-warlock-accent">✓ {fix.mode}D fix · {fix.satellites_used ?? "?"} satellites used</div>;
}

function PositionTab({ fix, time }: { fix: FixResp | null; time: TimeResp | null }) {
  const copy = (v: string) => navigator.clipboard?.writeText(v);
  const ok = fix && fix.ok && (fix.mode ?? 0) >= 2;
  return (
    <div>
      <WaitingBanner fix={fix} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title="Latitude" value={ok ? fix!.lat?.toFixed(6) : "—"} onClick={ok ? () => copy(String(fix!.lat)) : undefined} />
        <StatCard title="Longitude" value={ok ? fix!.lon?.toFixed(6) : "—"} onClick={ok ? () => copy(String(fix!.lon)) : undefined} />
        <StatCard title="Altitude (m)" value={ok && fix!.alt != null ? fix!.alt.toFixed(1) : "—"} />
        <StatCard title="Fix" value={fix ? (fix.mode === 3 ? "3D" : fix.mode === 2 ? "2D" : "no fix") : "…"} />
        <StatCard title="Speed (m/s)" value={ok && fix!.speed_mps != null ? fix!.speed_mps.toFixed(2) : "—"} />
        <StatCard title="Heading" value={ok && fix!.track_deg != null ? `${fix!.track_deg.toFixed(0)}°` : "—"} />
        <StatCard title="HDOP" value={fix?.hdop != null ? String(fix.hdop) : "—"} />
        <StatCard title="Sats used/seen" value={`${fix?.satellites_used ?? "?"}/${fix?.satellites_seen ?? "?"}`} />
      </div>
      {time?.tracking && (
        <div className="wl-card mt-4">
          <div className="text-xs uppercase tracking-wider text-warlock-muted mb-1">chrony (time)</div>
          <div>stratum <b>{time.tracking.stratum ?? "?"}</b> · last offset <b>{time.tracking.last_offset_s != null ? (time.tracking.last_offset_s * 1000).toFixed(3) : "—"} ms</b> · ref {time.tracking.reference_id}</div>
          <div className="text-xs text-warlock-muted mt-1">
            PPS: {time.pps?.present ? (time.pps.pulsing ? "device present, pulsing" : "device present, quiet (waiting for fix)") : "no /dev/pps0"}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value, onClick }: { title: string; value: React.ReactNode; onClick?: () => void }) {
  return (
    <div className={"wl-card min-h-[5rem] " + (onClick ? "cursor-pointer hover:border-warlock-accent" : "")} onClick={onClick} title={onClick ? "Click to copy" : undefined}>
      <div className="text-xs uppercase tracking-wider text-warlock-muted">{title}</div>
      <div className="text-xl font-bold text-warlock-accent">{value ?? "—"}</div>
    </div>
  );
}

function MapTab({ fix, recording }: { fix: FixResp | null; recording: boolean }) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const trackRef = useRef<L.Polyline | null>(null);
  const trailRef = useRef<L.LatLngExpression[]>([]);

  useEffect(() => {
    if (!mapEl.current) return;
    const lat = fix?.lat ?? 30.2672;  // Default: Austin TX
    const lon = fix?.lon ?? -97.7431;
    if (!mapRef.current) {
      mapRef.current = L.map(mapEl.current).setView([lat, lon], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(mapRef.current);
      trackRef.current = L.polyline([], { color: "red", weight: 3 }).addTo(mapRef.current);
    }
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      trackRef.current = null;
      trailRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    if (!fix || (fix.mode ?? 0) < 2 || fix.lat == null || fix.lon == null) return;
    const ll: L.LatLngExpression = [fix.lat, fix.lon];
    if (markerRef.current) markerRef.current.setLatLng(ll);
    else markerRef.current = L.marker(ll).addTo(mapRef.current);
    if (recording) {
      trailRef.current.push(ll);
      trackRef.current?.setLatLngs(trailRef.current);
    } else if (trailRef.current.length > 0) {
      trailRef.current = [];
      trackRef.current?.setLatLngs([]);
    }
    mapRef.current.panTo(ll, { animate: true });
  }, [fix?.lat, fix?.lon, fix?.mode, recording]);

  return (
    <div>
      <WaitingBanner fix={fix} />
      <div ref={mapEl} className="w-full rounded border border-warlock-border" style={{ height: "520px" }} />
      <div className="text-xs text-warlock-muted mt-2">
        OSM tiles · marker auto-centres on live position · live track line shown while recording
      </div>
    </div>
  );
}

function SatsTab({ sats }: { sats: SatsResp | null }) {
  const [sortBy, setSortBy] = useState<keyof Sat>("snr");
  const [descending, setDesc] = useState(true);
  const list = (sats?.satellites ?? []).slice().sort((a, b) => {
    const av = (a[sortBy] as any) ?? -1;
    const bv = (b[sortBy] as any) ?? -1;
    if (av < bv) return descending ? 1 : -1;
    if (av > bv) return descending ? -1 : 1;
    return 0;
  });
  const header = (k: keyof Sat, label: string) => (
    <th onClick={() => { if (sortBy === k) setDesc(!descending); else { setSortBy(k); setDesc(true); } }}
        className="cursor-pointer px-2 py-1 text-left hover:text-warlock-accent">
      {label}{sortBy === k ? (descending ? " ↓" : " ↑") : ""}
    </th>
  );
  return (
    <div>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="wl-card">
          <div className="text-xs uppercase tracking-wider text-warlock-muted mb-2">Sky view (zenith center, N up)</div>
          <SkyPolar sats={sats?.satellites ?? []} />
        </div>
        <div className="wl-card overflow-auto">
          <div className="text-xs uppercase tracking-wider text-warlock-muted mb-2">
            Satellites · {sats?.used ?? 0} used / {sats?.seen ?? 0} seen
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-warlock-border">
              <tr>
                {header("prn", "PRN")}
                {header("constellation", "Const")}
                {header("elevation", "Elev")}
                {header("azimuth", "Az")}
                {header("snr", "SNR")}
                {header("used", "Used")}
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-warlock-muted">no satellites in SKY frame yet</td></tr>}
              {list.map((s, i) => (
                <tr key={`${s.prn}-${i}`} className="border-b border-warlock-border/30">
                  <td className="px-2 py-1">{s.prn ?? "?"}</td>
                  <td className="px-2 py-1">{s.constellation}</td>
                  <td className="px-2 py-1">{s.elevation ?? "—"}</td>
                  <td className="px-2 py-1">{s.azimuth ?? "—"}</td>
                  <td className="px-2 py-1">{s.snr ?? "—"}</td>
                  <td className="px-2 py-1">{s.used ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SkyPolar({ sats }: { sats: Sat[] }) {
  const R = 140;
  const cx = R + 10;
  const cy = R + 10;
  const snrColor = (snr?: number) => {
    const v = snr ?? 0;
    if (v >= 35) return "#4ade80";
    if (v >= 20) return "#facc15";
    if (v > 0) return "#f97316";
    return "#6b7280";
  };
  return (
    <svg viewBox={`0 0 ${2 * (R + 10)} ${2 * (R + 10)}`} className="w-full h-[300px]">
      {[R, (R * 2) / 3, R / 3].map((r, i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="#334155" strokeDasharray="2 3" />
      ))}
      <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="#334155" />
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="#334155" />
      <text x={cx} y={cy - R - 2} textAnchor="middle" fill="#94a3b8" fontSize="11">N</text>
      <text x={cx} y={cy + R + 10} textAnchor="middle" fill="#94a3b8" fontSize="11">S</text>
      <text x={cx + R + 6} y={cy + 4} fill="#94a3b8" fontSize="11">E</text>
      <text x={cx - R - 10} y={cy + 4} fill="#94a3b8" fontSize="11">W</text>
      {sats.map((s, i) => {
        if (s.elevation == null || s.azimuth == null) return null;
        const r = ((90 - Math.max(0, Math.min(90, s.elevation))) / 90) * R;
        const rad = (s.azimuth * Math.PI) / 180;
        const x = cx + r * Math.sin(rad);
        const y = cy - r * Math.cos(rad);
        const size = 4 + Math.min(8, (s.snr ?? 0) / 6);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={size} fill={snrColor(s.snr)} fillOpacity={s.used ? 0.9 : 0.3} stroke="#0f172a" strokeWidth={1} />
            <text x={x} y={y + size + 9} textAnchor="middle" fill="#cbd5e1" fontSize="9">{s.prn}</text>
          </g>
        );
      })}
    </svg>
  );
}

function TracksTab({ data, reload }: { data: TracksResp | null; reload: () => void }) {
  const rec = data?.recording;
  const busy = rec?.active;
  const start = async () => { try { await apiPost("/api/gps/tracks/start"); } catch (e) { alert(String(e)); } reload(); };
  const stop = async () => { try { await apiPost("/api/gps/tracks/stop"); } catch (e) { alert(String(e)); } reload(); };
  const del = async (fn: string) => {
    if (!confirm(`Delete ${fn}?`)) return;
    try {
      const r = await fetch(`/api/gps/tracks/${encodeURIComponent(fn)}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    } catch (e) { alert(String(e)); }
    reload();
  };
  return (
    <div>
      <div className="wl-card mb-3 flex items-center gap-3">
        <button className="wl-btn" onClick={start} disabled={busy}>▶ Start recording</button>
        <button className="wl-btn-danger" onClick={stop} disabled={!busy}>■ Stop recording</button>
        <span className="text-sm">
          {busy ? (
            <span className="text-warlock-accent">● REC <b>{rec?.filename}</b> · {rec?.points ?? 0} points</span>
          ) : (
            <span className="text-warlock-muted">not recording</span>
          )}
        </span>
      </div>
      <div className="wl-card overflow-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-warlock-border">
            <tr>
              <th className="px-2 py-1 text-left">filename</th>
              <th className="px-2 py-1 text-left">started</th>
              <th className="px-2 py-1 text-right">duration (s)</th>
              <th className="px-2 py-1 text-right">points</th>
              <th className="px-2 py-1 text-right">size (KB)</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.tracks ?? []).length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-warlock-muted">no tracks yet</td></tr>}
            {(data?.tracks ?? []).map((t) => (
              <tr key={t.filename} className="border-b border-warlock-border/30">
                <td className="px-2 py-1 font-mono">{t.filename}</td>
                <td className="px-2 py-1">{(t.started_at ?? "").slice(0, 19)}</td>
                <td className="px-2 py-1 text-right">{t.duration_s ?? "—"}</td>
                <td className="px-2 py-1 text-right">{t.points}</td>
                <td className="px-2 py-1 text-right">{Math.round(t.size_bytes / 1024)}</td>
                <td className="px-2 py-1 text-right">
                  <a className="wl-btn mr-2" href={`/api/gps/tracks/${encodeURIComponent(t.filename)}`} download>⇣</a>
                  <button className="wl-btn-danger" onClick={() => del(t.filename)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
