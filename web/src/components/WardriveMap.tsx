// WardriveMap — Mapbox-tiled Leaflet map for wardriving visualization.
// Uses Mapbox dark tiles when API key is configured, falls back to CARTO dark matter.
// Plots GPS track as a polyline + APs as colored pin drops (color = encryption type).
import { useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Tile } from "./hud";

type WardriveData = {
  track_points: number;
  ap_total: number;
  ap_geolocated: number;
  bounds: { min_lat: number; max_lat: number; min_lon: number; max_lon: number } | null;
  track: { lat: number; lon: number }[];
  aps: {
    bssid: string; essid: string; channel: number;
    privacy: string; power: number; lat: number; lon: number;
  }[];
};

type MapConfig = {
  has_key: boolean;
  api_key: string;
  style: string;
  tile_url: string;
  fallback_tile_url: string;
};

// Encryption → color mapping
const ENC_COLORS: Record<string, string> = {
  "WPA3": "#16a34a",
  "WPA3 WPA2": "#22c55e",
  "WPA2": "#3b82f6",
  "WEP": "#f59e0b",
  "OPN": "#ef4444",
  "": "#6b7280",
};

function encColor(privacy: string): string {
  if (!privacy || privacy === "OPN" || privacy === "") return ENC_COLORS[""];
  if (privacy.includes("WPA3")) return ENC_COLORS["WPA3"];
  if (privacy.includes("WPA2")) return ENC_COLORS["WPA2"];
  if (privacy.includes("WEP")) return ENC_COLORS["WEP"];
  return ENC_COLORS[""];
}

function FitBounds({ data }: { data: WardriveData | null }) {
  const map = useMap();
  useEffect(() => {
    if (!data?.bounds) return;
    const b = data.bounds;
    const bounds: L.LatLngBoundsExpression = [
      [b.min_lat, b.min_lon],
      [b.max_lat, b.max_lon],
    ];
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
  }, [data, map]);
  return null;
}

export default function WardriveMap() {
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [data, setData] = useState<WardriveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showTrack, setShowTrack] = useState(true);
  const [showAPs, setShowAPs] = useState(true);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/maps/config", {
        headers: { Authorization: "Basic " + btoa("warlock:warlock") },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConfig(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "config load failed");
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/maps/wardrive?max_points=3000", {
        headers: { Authorization: "Basic " + btoa("warlock:warlock") },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "data load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadData();
    // Refresh every 15s during active wardriving
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadConfig, loadData]);

  const exportGeoJSON = useCallback(async () => {
    try {
      const res = await fetch("/api/maps/geojson", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + btoa("warlock:warlock"),
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      alert(`GeoJSON exported: ${result.features} features\n${result.path}`);
    } catch (e) {
      alert("Export failed: " + (e instanceof Error ? e.message : "unknown"));
    }
  }, []);

  const center: [number, number] = useMemo(() => {
    if (data?.track.length) {
      const mid = data.track[Math.floor(data.track.length / 2)];
      return [mid.lat, mid.lon];
    }
    return [30.4345, -97.6835]; // Default: office location
  }, [data]);

  const trackPath = useMemo(() => {
    if (!data?.track.length) return null;
    return data.track.map((p) => [p.lat, p.lon] as [number, number]);
  }, [data]);

  const tileUrl = config?.has_key ? config.tile_url : config?.fallback_tile_url;
  const mapContent = (
    <MapContainer
      center={center}
      zoom={16}
      style={{ height: "100%", width: "100%", background: "#05070f" }}
      scrollWheelZoom={true}
    >
      {tileUrl && (
        <TileLayer
          url={tileUrl}
          attribution={config?.has_key ? "© Mapbox © OpenStreetMap" : "© CARTO © OpenStreetMap"}
          subdomains={config?.has_key ? [] : ["a", "b", "c", "d"]}
        />
      )}
      <FitBounds data={data} />

      {/* GPS track */}
      {showTrack && trackPath && trackPath.length > 1 && (
        <Polyline
          positions={trackPath}
          pathOptions={{ color: "#06b6d4", weight: 3, opacity: 0.7 }}
        />
      )}

      {/* AP pin drops */}
      {showAPs && data?.aps.map((ap, i) => (
        <CircleMarker
          key={`${ap.bssid}-${i}`}
          center={[ap.lat, ap.lon]}
          radius={5 + Math.max(0, (ap.power + 100) / 10)}
          pathOptions={{
            color: encColor(ap.privacy),
            fillColor: encColor(ap.privacy),
            fillOpacity: 0.6,
            weight: 1,
          }}
        >
          <Popup>
            <div style={{ fontSize: "11px", lineHeight: "1.5" }}>
              <strong style={{ color: "#c4b5fd" }}>{ap.essid || "(hidden)"}</strong>
              <br />
              <b>BSSID:</b> {ap.bssid}
              <br />
              <b>Ch:</b> {ap.channel} · <b>Enc:</b> {ap.privacy || "Open"}
              <br />
              <b>Power:</b> {ap.power} dBm
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );

  return (
    <>
      {/* Stats bar */}
      <div className="flex items-center gap-3 mb-3 text-xs flex-wrap">
        <span className="text-cyan-signal">
          <strong>{data?.track_points ?? 0}</strong> GPS pts
        </span>
        <span className="text-amber-base">
          <strong>{data?.ap_total ?? 0}</strong> APs
        </span>
        <span className="text-mint-safe">
          <strong>{data?.ap_geolocated ?? 0}</strong> geolocated
        </span>
        {config && (
          <span className={config.has_key ? "text-mint-safe" : "text-amber-base"}>
            {config.has_key ? "Mapbox ✓" : "CARTO fallback (no Mapbox key)"}
          </span>
        )}
        <button
          onClick={() => setShowTrack(!showTrack)}
          className={`px-2 py-0.5 rounded text-[0.65rem] border ${showTrack ? "border-cyan-signal text-cyan-signal" : "border-line-dim text-txt-dim"}`}
        >
          TRACK
        </button>
        <button
          onClick={() => setShowAPs(!showAPs)}
          className={`px-2 py-0.5 rounded text-[0.65rem] border ${showAPs ? "border-amber-base text-amber-base" : "border-line-dim text-txt-dim"}`}
        >
          APS
        </button>
        <button
          onClick={exportGeoJSON}
          className="px-2 py-0.5 rounded text-[0.65rem] border border-violet-bright text-violet-bright hover:bg-violet-bright/10"
        >
          ↓ GEOJSON
        </button>
        <button
          onClick={() => setFullscreen(true)}
          className="px-2 py-0.5 rounded text-[0.65rem] border border-line-dim text-txt-dim hover:border-amber-base hover:text-amber-base"
        >
          ⛶ FULL
        </button>
        <button
          onClick={loadData}
          className="px-2 py-0.5 rounded text-[0.65rem] border border-line-dim text-txt-dim hover:border-mint-safe hover:text-mint-safe"
        >
          ↻
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mb-2 text-[0.65rem] text-txt-dim flex-wrap">
        {Object.entries({ "WPA3": "#16a34a", "WPA2": "#3b82f6", "WEP": "#f59e0b", "Open": "#ef4444" }).map(([label, color]) => (
          <span key={label} className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5" style={{ background: "#06b6d4" }} />
          GPS Track
        </span>
      </div>

      {/* Map container */}
      <div className="relative rounded-lg overflow-hidden border border-line-dim" style={{ height: "500px" }}>
        {loading ? (
          <div className="flex items-center justify-center h-full text-txt-dim">Loading map...</div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-pink-alert">Error: {error}</div>
        ) : (
          mapContent
        )}
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && createPortal(
        <div
          className="fixed inset-0 z-[9999] bg-black/90 flex flex-col"
          onClick={() => setFullscreen(false)}
        >
          <div className="flex items-center justify-between p-3 text-sm">
            <span className="text-amber-base font-semibold">WARDRIVE MAP</span>
            <button
              onClick={() => setFullscreen(false)}
              className="px-3 py-1 rounded border border-line-dim text-txt-dim hover:border-pink-alert hover:text-pink-alert"
            >
              ✕ CLOSE
            </button>
          </div>
          <div className="flex-1 m-3 rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {!loading && !error && mapContent}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
