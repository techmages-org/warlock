import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, Tile } from "../components/hud";

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
      const [f, s] = await Promise.all([
        apiGet<FixResp>("/api/gps/fix"),
        apiGet<SatsResp>("/api/gps/sats"),
      ]);
      setFix(f);
      setSats(s);
    } catch { /* swallow — UI shows stale last */ }
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
      } catch { /**/ }
    };
    load();
    const id = setInterval(() => { if (alive) load(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "position") return;
    let alive = true;
    const load = async () => {
      try {
        const t = await apiGet<TimeResp>("/api/gps/time");
        if (alive) setTimeStatus(t);
      } catch { /**/ }
    };
    load();
    const id = setInterval(() => { if (alive) load(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  const ok = fix && fix.ok && (fix.mode ?? 0) >= 2;
  const stateLabel = !fix
    ? "ACQUIRING"
    : !fix.ok
    ? "GPSD LINK DOWN"
    : (fix.mode ?? 0) >= 2
    ? `${fix.mode}D FIX`
    : "NO FIX";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="02 GPS-NAV"
        title="GPS Navigation"
        state={stateLabel}
        icon="🛰"
        right={
          <span className="hud-label text-txt-dim">
            ublox via gpsd · {fix?.satellites_used ?? "?"}/{fix?.satellites_seen ?? "?"} sats
          </span>
        }
      />

      <div role="tablist" aria-label="gps sections" className="flex flex-wrap gap-1">
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

      <WaitingBanner fix={fix} ok={!!ok} />

      {tab === "position" && <PositionTab fix={fix} time={timeStatus} />}
      {tab === "map" && <MapTab fix={fix} recording={tracks?.recording?.active ?? false} />}
      {tab === "sats" && <SatsTab sats={sats} />}
      {tab === "tracks" && (
        <TracksTab data={tracks} reload={() => apiGet<TracksResp>("/api/gps/tracks").then(setTracks).catch(() => {})} />
      )}
    </div>
  );
}

function WaitingBanner({ fix, ok }: { fix: FixResp | null; ok: boolean }) {
  if (!fix) {
    return (
      <div className="hud-tile px-3 py-2 text-txt-dim">acquiring gpsd stream…</div>
    );
  }
  if (!fix.ok) {
    return (
      <div className="hud-tile border-pink-alert px-3 py-2 text-pink-alert">
        ✕ gpsd: {fix.reason ?? "disconnected"}
      </div>
    );
  }
  if (!ok) {
    return (
      <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">
        ⚠ waiting for fix — {fix.waiting ?? "no sky view yet"}
      </div>
    );
  }
  return (
    <div className="hud-tile border-mint-safe px-3 py-2 text-mint-safe">
      ✓ {fix.mode}D fix · {fix.satellites_used ?? "?"} satellites used
    </div>
  );
}

function PositionTab({ fix, time }: { fix: FixResp | null; time: TimeResp | null }) {
  const copy = (v: string) => navigator.clipboard?.writeText(v);
  const ok = fix && fix.ok && (fix.mode ?? 0) >= 2;
  const hasFixFields = !!ok;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="LATITUDE">
          <button
            type="button"
            className="text-left disabled:cursor-default"
            onClick={() => hasFixFields && copy(String(fix!.lat))}
            disabled={!hasFixFields}
            title={hasFixFields ? "click to copy" : undefined}
          >
            <BigValue
              value={hasFixFields ? fix!.lat!.toFixed(6) : "—"}
              color={hasFixFields ? "amber" : "dim"}
              flashOnChange
            />
          </button>
          {!hasFixFields && <div className="mt-2 text-txt-dim">AWAITING SKY VIEW</div>}
        </Tile>

        <Tile title="LONGITUDE">
          <button
            type="button"
            className="text-left disabled:cursor-default"
            onClick={() => hasFixFields && copy(String(fix!.lon))}
            disabled={!hasFixFields}
            title={hasFixFields ? "click to copy" : undefined}
          >
            <BigValue
              value={hasFixFields ? fix!.lon!.toFixed(6) : "—"}
              color={hasFixFields ? "amber" : "dim"}
              flashOnChange
            />
          </button>
          {!hasFixFields && <div className="mt-2 text-txt-dim">AWAITING SKY VIEW</div>}
        </Tile>

        <Tile title="ALTITUDE">
          <BigValue
            value={hasFixFields && fix!.alt != null ? fix!.alt.toFixed(1) : "—"}
            unit="m"
            color={hasFixFields ? "amber" : "dim"}
          />
        </Tile>

        <Tile title="FIX">
          <BigValue
            value={fix ? (fix.mode === 3 ? "3D" : fix.mode === 2 ? "2D" : "—") : "…"}
            color={hasFixFields ? "mint" : "amber"}
            size="md"
          />
        </Tile>

        <Tile title="SPEED">
          <BigValue
            value={hasFixFields && fix!.speed_mps != null ? fix!.speed_mps.toFixed(2) : "—"}
            unit="m/s"
            color={hasFixFields ? "cyan" : "dim"}
          />
        </Tile>

        <Tile title="HEADING">
          <BigValue
            value={hasFixFields && fix!.track_deg != null ? `${fix!.track_deg.toFixed(0)}°` : "—"}
            color={hasFixFields ? "cyan" : "dim"}
          />
        </Tile>

        <Tile title="HDOP">
          <BigValue
            value={fix?.hdop != null ? String(fix.hdop) : "—"}
            color={fix?.hdop != null && fix.hdop < 5 ? "mint" : "amber"}
          />
        </Tile>

        <Tile title="SATS USED / SEEN">
          <BigValue
            value={`${fix?.satellites_used ?? "?"}/${fix?.satellites_seen ?? "?"}`}
            color="violet"
            flashOnChange
          />
        </Tile>
      </div>

      {time?.tracking && (
        <Tile title="CHRONY / TIME" led="cyan">
          <div className="text-txt-body">
            stratum{" "}
            <span className="text-amber-base tabular-nums">
              {time.tracking.stratum ?? "?"}
            </span>
            <span className="mx-2 text-txt-dim">·</span>
            last offset{" "}
            <span className="text-cyan-signal tabular-nums">
              {time.tracking.last_offset_s != null
                ? (time.tracking.last_offset_s * 1000).toFixed(3)
                : "—"}
            </span>{" "}
            ms
            <span className="mx-2 text-txt-dim">·</span>
            ref{" "}
            <span className="text-violet-bright">{time.tracking.reference_id ?? "—"}</span>
          </div>
          <div className="mt-2 text-txt-dim">
            PPS:{" "}
            {time.pps?.present
              ? time.pps.pulsing
                ? "device present · pulsing"
                : "device present · quiet (waiting for fix)"
              : "no /dev/pps0"}
          </div>
        </Tile>
      )}
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
    const lat = fix?.lat ?? 30.2672; // Default: Austin TX
    const lon = fix?.lon ?? -97.7431;
    if (!mapRef.current) {
      mapRef.current = L.map(mapEl.current).setView([lat, lon], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(mapRef.current);
      trackRef.current = L.polyline([], { color: "#ff2975", weight: 3 }).addTo(mapRef.current);
    }
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      trackRef.current = null;
      trailRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [fix?.lat, fix?.lon, fix?.mode, recording, fix]);

  return (
    <Tile title="LIVE MAP" led={fix && fix.ok && (fix.mode ?? 0) >= 2 ? "mint" : "amber"} padded={false}>
      <div
        ref={mapEl}
        className="w-full border border-line-dim"
        style={{ height: "520px" }}
      />
      <div className="border-t border-line-dim px-4 py-2 text-txt-dim">
        OSM tiles · marker auto-centres on live position · live track in amber-pink while recording
      </div>
    </Tile>
  );
}

function SatsTab({ sats }: { sats: SatsResp | null }) {
  const [sortBy, setSortBy] = useState<keyof Sat>("snr");
  const [descending, setDesc] = useState(true);
  const list = (sats?.satellites ?? []).slice().sort((a, b) => {
    const av = (a[sortBy] as number | boolean | string | undefined) ?? -1;
    const bv = (b[sortBy] as number | boolean | string | undefined) ?? -1;
    if (av < bv) return descending ? 1 : -1;
    if (av > bv) return descending ? -1 : 1;
    return 0;
  });
  const header = (k: keyof Sat, label: string) => (
    <th
      onClick={() => {
        if (sortBy === k) setDesc(!descending);
        else { setSortBy(k); setDesc(true); }
      }}
      className="cursor-pointer px-3 py-2 text-left hud-label hover:text-amber-base"
    >
      {label}
      {sortBy === k ? (descending ? " ↓" : " ↑") : ""}
    </th>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Tile title="SKY VIEW" headerRight={<span className="hud-label text-txt-dim">zenith centre · N up</span>} led="cyan">
        <SkyPolar sats={sats?.satellites ?? []} />
      </Tile>
      <Tile
        title="SATELLITES"
        led={sats?.used && sats.used > 0 ? "mint" : "amber"}
        headerRight={
          <span className="hud-label text-txt-dim tabular-nums">
            {sats?.used ?? 0} used / {sats?.seen ?? 0} seen
          </span>
        }
        padded={false}
      >
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                {header("prn", "PRN")}
                {header("constellation", "Const")}
                {header("elevation", "Elev")}
                {header("azimuth", "Az")}
                {header("snr", "SNR")}
                {header("used", "Used")}
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-3 text-txt-dim">
                    no satellites in SKY frame yet
                  </td>
                </tr>
              )}
              {list.map((s, i) => (
                <tr key={`${s.prn}-${i}`} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 tabular-nums text-txt-body">{s.prn ?? "?"}</td>
                  <td className="px-3 py-1 text-violet-bright">{s.constellation}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-body">{s.elevation ?? "—"}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-body">{s.azimuth ?? "—"}</td>
                  <td className="px-3 py-1 tabular-nums text-cyan-signal">{s.snr ?? "—"}</td>
                  <td className="px-3 py-1">
                    {s.used ? <span className="text-mint-safe">✓</span> : <span className="text-txt-dim">·</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
    </div>
  );
}

function SkyPolar({ sats }: { sats: Sat[] }) {
  const R = 140;
  const cx = R + 10;
  const cy = R + 10;
  const snrColor = (snr?: number) => {
    const v = snr ?? 0;
    if (v >= 35) return "var(--mint-safe)";
    if (v >= 20) return "var(--amber-base)";
    if (v > 0) return "var(--amber-deep)";
    return "var(--txt-dim)";
  };
  return (
    <svg viewBox={`0 0 ${2 * (R + 10)} ${2 * (R + 10)}`} className="h-[300px] w-full">
      {[R, (R * 2) / 3, R / 3].map((r, i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="var(--line-dim)" strokeDasharray="2 3" />
      ))}
      <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="var(--line-dim)" />
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="var(--line-dim)" />
      <text x={cx} y={cy - R - 2} textAnchor="middle" fill="var(--violet-bright)" fontSize="11">N</text>
      <text x={cx} y={cy + R + 10} textAnchor="middle" fill="var(--txt-dim)" fontSize="11">S</text>
      <text x={cx + R + 6} y={cy + 4} fill="var(--txt-dim)" fontSize="11">E</text>
      <text x={cx - R - 10} y={cy + 4} fill="var(--txt-dim)" fontSize="11">W</text>
      {sats.map((s, i) => {
        if (s.elevation == null || s.azimuth == null) return null;
        const r = ((90 - Math.max(0, Math.min(90, s.elevation))) / 90) * R;
        const rad = (s.azimuth * Math.PI) / 180;
        const x = cx + r * Math.sin(rad);
        const y = cy - r * Math.cos(rad);
        const size = 4 + Math.min(8, (s.snr ?? 0) / 6);
        return (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r={size}
              fill={snrColor(s.snr)}
              fillOpacity={s.used ? 0.9 : 0.35}
              stroke="var(--bg-strip)"
              strokeWidth={1}
            />
            <text x={x} y={y + size + 9} textAnchor="middle" fill="var(--txt-body)" fontSize="9">
              {s.prn}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function TracksTab({ data, reload }: { data: TracksResp | null; reload: () => void }) {
  const rec = data?.recording;
  const busy = rec?.active;
  const start = async () => {
    try { await apiPost("/api/gps/tracks/start"); } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    reload();
  };
  const stop = async () => {
    try { await apiPost("/api/gps/tracks/stop"); } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    reload();
  };
  const del = async (fn: string) => {
    if (!confirm(`Delete ${fn}?`)) return;
    try {
      const r = await fetch(`/api/gps/tracks/${encodeURIComponent(fn)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
    reload();
  };
  return (
    <div className="space-y-3">
      <Tile title="RECORDER" led={busy ? "pink" : "dim"}>
        <div className="flex flex-wrap items-center gap-3">
          <button className="hud-btn" onClick={start} disabled={busy}>▶ Start recording</button>
          <button className="hud-btn hud-btn-danger" onClick={stop} disabled={!busy}>■ Stop recording</button>
          <span>
            {busy ? (
              <span className="text-pink-alert">
                ● REC <b className="text-amber-base">{rec?.filename}</b>
                <span className="ml-2 tabular-nums text-cyan-signal">{rec?.points ?? 0}</span> points
              </span>
            ) : (
              <span className="text-txt-dim">not recording</span>
            )}
          </span>
        </div>
      </Tile>

      <Tile title="TRACK ARCHIVE" padded={false}>
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="px-3 py-2 text-left hud-label">filename</th>
                <th className="px-3 py-2 text-left hud-label">started</th>
                <th className="px-3 py-2 text-right hud-label">duration (s)</th>
                <th className="px-3 py-2 text-right hud-label">points</th>
                <th className="px-3 py-2 text-right hud-label">size (KB)</th>
                <th className="px-3 py-2 hud-label" />
              </tr>
            </thead>
            <tbody>
              {(data?.tracks ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-3 text-txt-dim">no tracks yet</td>
                </tr>
              )}
              {(data?.tracks ?? []).map((t) => (
                <tr key={t.filename} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 text-violet-bright">{t.filename}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-body">{(t.started_at ?? "").slice(0, 19)}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{t.duration_s ?? "—"}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{t.points}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{Math.round(t.size_bytes / 1024)}</td>
                  <td className="flex items-center justify-end gap-2 px-3 py-1">
                    <a className="hud-btn" href={`/api/gps/tracks/${encodeURIComponent(t.filename)}`} download>⇣</a>
                    <button className="hud-btn hud-btn-danger" onClick={() => del(t.filename)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
    </div>
  );
}
