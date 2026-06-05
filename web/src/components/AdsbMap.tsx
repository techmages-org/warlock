// Native in-app ADS-B map for the SDR module. Phosphor-HUD themed Leaflet map
// (CARTO dark-matter tiles — no API key) plotting live aircraft as heading-
// rotated plane glyphs, centred on the Granger TX receiver, with a
// click-to-expand fullscreen view. Aircraft data is fed in from the parent
// Sdr poll loop (no extra fetch here). All Leaflet style overrides live in the
// <style> block below so this stays self-contained.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Tile } from "./hud";

// Receiver site — Granger, TX. The map always centres here.
export const RECEIVER = { lat: 30.7188, lon: -97.4436 } as const;

// Full readsb aircraft intel shape (structurally compatible with the SDR page's
// 9-field Aircraft type — every enriched field below is optional, so a plain
// 9-field row stays assignable, and the runtime objects carry the extra props
// the backend now passes through). readsb omits any field it can't decode, so
// the card degrades to "—" gracefully for whatever's missing.
export type MapAircraft = {
  // --- original 9 ---
  icao: string;
  callsign: string | null;
  altitude_ft: number | string | null; // "ground" when on the deck
  speed_kt: number | null;
  heading: number | null;
  lat: number | null;
  lon: number | null;
  seen_s: number | null;
  squawk: string | null;
  // --- enriched (all optional) ---
  rssi?: number | null;
  registration?: string | null;
  type?: string | null;
  type_desc?: string | null;
  operator?: string | null;
  db_flags?: number | null;
  category?: string | null;
  alt_geom_ft?: number | string | null;
  ias?: number | null;
  tas?: number | null;
  mach?: number | null;
  mag_heading?: number | null;
  true_heading?: number | null;
  roll?: number | null;
  track_rate?: number | null;
  vert_rate_fpm?: number | null;
  geom_rate?: number | null;
  emergency?: string | null;
  sel_altitude_ft?: number | null;
  sel_heading?: number | null;
  nav_qnh?: number | null;
  nav_modes?: string[] | null;
  nic?: number | null;
  rc?: number | null;
  nac_p?: number | null;
  nac_v?: number | null;
  sil?: number | null;
  sil_type?: string | null;
  messages?: number | null;
  seen_pos_s?: number | null;
  wind_dir?: number | null;
  wind_speed?: number | null;
  oat?: number | null;
  tat?: number | null;
};

const NM = 1852; // metres per nautical mile — for range rings.

// db_flags is a bitfield: 1=Military, 2=Interesting, 4=PIA (Privacy ICAO
// Address), 8=LADD (Limiting Aircraft Data Displayed). Decode set bits to chips.
const DB_FLAGS: ReadonlyArray<readonly [number, string]> = [
  [1, "MIL"],
  [2, "INTEREST"],
  [4, "PIA"],
  [8, "LADD"],
];
function dbFlagChips(flags: number | null | undefined): string[] {
  if (!flags) return [];
  return DB_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, label]) => label);
}

const DASH = "—";

// Format a numeric value with optional unit + fixed decimals; "—" when absent.
// readsb sends alt_baro:"ground" for on-deck aircraft — pass strings through.
function num(
  v: number | string | null | undefined,
  unit = "",
  digits?: number,
): string {
  if (v == null) return DASH;
  if (typeof v === "string") return v; // e.g. "ground"
  if (Number.isNaN(v)) return DASH;
  const n = digits != null ? v.toFixed(digits) : v.toLocaleString();
  return unit ? `${n} ${unit}` : n;
}

// Great-circle distance (nm) from the Granger receiver to a position.
function haversineNm(lat: number, lon: number): number {
  const R = 6371000; // earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat - RECEIVER.lat);
  const dLon = toRad(lon - RECEIVER.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(RECEIVER.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return (R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))) / NM;
}

// Initial bearing (deg true) from the receiver to a position.
function bearingDeg(lat: number, lon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const p1 = toRad(RECEIVER.lat);
  const p2 = toRad(lat);
  const dl = toRad(lon - RECEIVER.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// One label:value pair inside a section grid.
function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <span className="adsb-k">{k}</span>
      <span className="adsb-v">{v}</span>
    </>
  );
}

// Full tar1090-parity intel card for a single aircraft, phosphor-HUD themed.
function PlanePopup({ a }: { a: MapAircraft }) {
  const hasPos = a.lat != null && a.lon != null;
  const dist = hasPos ? haversineNm(a.lat as number, a.lon as number) : null;
  const brg = hasPos ? bearingDeg(a.lat as number, a.lon as number) : null;
  const chips = dbFlagChips(a.db_flags);
  const modes = a.nav_modes && a.nav_modes.length ? a.nav_modes.join(" ") : null;
  const hasFms =
    a.sel_altitude_ft != null || a.sel_heading != null || a.nav_qnh != null || modes != null;
  const hasWind =
    a.wind_speed != null || a.wind_dir != null || a.oat != null || a.tat != null;
  const integrity =
    a.nic != null || a.rc != null || a.nac_p != null || a.nac_v != null || a.sil != null;

  return (
    <div className="adsb-pop adsb-card">
      {/* Header: callsign + registration/type/operator + ICAO/squawk/flags */}
      <div className="adsb-pop-h">{a.callsign?.trim() || a.registration || a.icao}</div>
      <div className="adsb-pop-sub">
        <b>{a.registration || DASH}</b>
        {" · "}
        {a.type || DASH}
        {a.type_desc ? ` · ${a.type_desc}` : ""}
      </div>
      {a.operator ? <div className="adsb-pop-sub adsb-op">{a.operator}</div> : null}
      <div className="adsb-pop-sub">
        icao <b>{a.icao}</b>
        {a.squawk ? ` · sq ${a.squawk}` : ""}
        {a.category ? ` · cat ${a.category}` : ""}
        {a.emergency && a.emergency !== "none" ? (
          <span className="adsb-emrg"> · {a.emergency.toUpperCase()}</span>
        ) : null}
      </div>
      <div className="adsb-chips">
        {chips.length ? (
          chips.map((c) => (
            <span key={c} className="adsb-chip">
              {c}
            </span>
          ))
        ) : (
          <span className="adsb-chip adsb-chip-off">DB: none</span>
        )}
      </div>

      {/* SPATIAL */}
      <div className="adsb-sec-h">SPATIAL</div>
      <div className="adsb-grid">
        <Row k="Ground spd" v={num(a.speed_kt, "kt")} />
        <Row k="IAS / TAS" v={`${num(a.ias)} / ${num(a.tas, "kt")}`} />
        <Row k="Mach" v={num(a.mach, "", 3)} />
        <Row k="Baro alt" v={num(a.altitude_ft, "ft")} />
        <Row k="WGS84 alt" v={num(a.alt_geom_ft, "ft")} />
        <Row k="Vert rate" v={num(a.vert_rate_fpm, "fpm")} />
        <Row k="Geom rate" v={num(a.geom_rate, "fpm")} />
        <Row k="Track" v={num(a.heading, "°")} />
        <Row k="Mag / True hdg" v={`${num(a.mag_heading)} / ${num(a.true_heading)}`} />
        <Row k="Position" v={hasPos ? `${(a.lat as number).toFixed(4)}, ${(a.lon as number).toFixed(4)}` : DASH} />
        <Row k="Distance" v={dist != null ? `${dist.toFixed(1)} nm` : DASH} />
        <Row k="Bearing" v={brg != null ? `${brg.toFixed(0)}°` : DASH} />
      </div>

      {/* SIGNAL */}
      <div className="adsb-sec-h">SIGNAL</div>
      <div className="adsb-grid">
        <Row k="RSSI" v={num(a.rssi, "dBFS", 1)} />
        <Row k="Messages" v={num(a.messages)} />
        <Row k="Last pos" v={a.seen_pos_s != null ? `${a.seen_pos_s.toFixed(1)} s` : DASH} />
        <Row k="Last seen" v={a.seen_s != null ? `${a.seen_s.toFixed(1)} s` : DASH} />
        {integrity ? (
          <Row
            k="NIC/Rc"
            v={`${num(a.nic)} / ${a.rc != null ? `${a.rc} m` : DASH}`}
          />
        ) : null}
        {integrity ? (
          <Row
            k="NACp/v · SIL"
            v={`${num(a.nac_p)}/${num(a.nac_v)} · ${num(a.sil)}${a.sil_type ? ` (${a.sil_type})` : ""}`}
          />
        ) : null}
      </div>

      {/* FMS SEL — only when the aircraft is broadcasting selections */}
      {hasFms ? (
        <>
          <div className="adsb-sec-h">FMS SEL</div>
          <div className="adsb-grid">
            <Row k="Sel alt" v={num(a.sel_altitude_ft, "ft")} />
            <Row k="Sel head" v={num(a.sel_heading, "°")} />
            <Row k="QNH" v={num(a.nav_qnh, "hPa", 1)} />
            {modes ? <Row k="Modes" v={modes} /> : null}
          </div>
        </>
      ) : null}

      {/* WIND — derived, only when present */}
      {hasWind ? (
        <>
          <div className="adsb-sec-h">WIND</div>
          <div className="adsb-grid">
            <Row k="Speed" v={num(a.wind_speed, "kt")} />
            <Row k="Direction" v={num(a.wind_dir, "°")} />
            <Row k="OAT / TAT" v={`${num(a.oat, "°C")} / ${num(a.tat, "°C")}`} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

const PLANE_PATH =
  "M12 2 L13.4 9 L21 13 L21 15 L13.4 12.6 L13 19 L16 21 L16 22 L12 21 L8 22 L8 21 L11 19 L10.6 12.6 L3 15 L3 13 L10.6 9 Z";

// A heading-rotated plane glyph plus an upright callsign/altitude label.
// `stale` aircraft (no recent message) render dim. Built as a divIcon so we
// never fall back to Leaflet's default marker images (which break under Vite).
function planeIcon(a: MapAircraft): L.DivIcon {
  const hdg = a.heading ?? 0;
  const stale = (a.seen_s ?? 0) > 30;
  const call = a.callsign?.trim() || a.icao;
  const alt =
    a.altitude_ft == null
      ? ""
      : typeof a.altitude_ft === "number"
        ? `${a.altitude_ft.toLocaleString()}ft`
        : a.altitude_ft; // e.g. "ground"
  const label = alt ? `${call} · ${alt}` : call;
  return L.divIcon({
    className: "adsb-plane",
    html:
      `<div class="adsb-plane-wrap${stale ? " adsb-stale" : ""}">` +
      `<svg class="adsb-plane-icon" width="22" height="22" viewBox="0 0 24 24" ` +
      `style="transform:rotate(${hdg}deg)"><path d="${PLANE_PATH}" ` +
      `fill="currentColor" stroke="#05070f" stroke-width="0.5"/></svg>` +
      `<span class="adsb-plane-label">${esc(label)}</span>` +
      `</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// Receiver site crosshair — violet diamond, distinct from aircraft.
const RECEIVER_ICON = L.divIcon({
  className: "adsb-recv",
  html:
    `<div class="adsb-recv-wrap"><svg width="20" height="20" viewBox="0 0 20 20">` +
    `<path d="M10 1 L19 10 L10 19 L1 10 Z" fill="none" stroke="currentColor" stroke-width="1.6"/>` +
    `<circle cx="10" cy="10" r="2.2" fill="currentColor"/>` +
    `</svg></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function MapView({ aircraft, fullscreen }: { aircraft: MapAircraft[]; fullscreen?: boolean }) {
  return (
    <MapContainer
      center={[RECEIVER.lat, RECEIVER.lon]}
      zoom={fullscreen ? 9 : 8}
      scrollWheelZoom
      preferCanvas
      className="h-full w-full"
      style={{ background: "#05070f" }}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
        attribution='&copy; OpenStreetMap contributors &copy; CARTO'
      />

      {/* Range rings around the receiver: 50 / 100 / 150 nm. */}
      {[50, 100, 150].map((nm) => (
        <Circle
          key={nm}
          center={[RECEIVER.lat, RECEIVER.lon]}
          radius={nm * NM}
          pathOptions={{
            color: "#a78bfa",
            weight: 1,
            opacity: 0.22,
            fill: false,
            dashArray: "3 6",
          }}
        />
      ))}

      <Marker position={[RECEIVER.lat, RECEIVER.lon]} icon={RECEIVER_ICON}>
        <Popup>
          <div className="adsb-pop">
            <div className="adsb-pop-h">RECEIVER · GRANGER TX</div>
            <div>{RECEIVER.lat.toFixed(4)}, {RECEIVER.lon.toFixed(4)}</div>
          </div>
        </Popup>
      </Marker>

      {aircraft.map((a) => (
        <Marker key={a.icao} position={[a.lat as number, a.lon as number]} icon={planeIcon(a)}>
          <Popup>
            <PlanePopup a={a} />
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

export function AdsbMap({ aircraft, active }: { aircraft: MapAircraft[]; active: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // Only aircraft with a decoded position can be plotted.
  const located = useMemo(
    () => aircraft.filter((a) => a.lat != null && a.lon != null),
    [aircraft],
  );

  // Esc closes the fullscreen view.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
      <style>{MAP_CSS}</style>

      <Tile
        title="LIVE MAP"
        padded={false}
        led={active ? "mint" : "amber"}
        headerRight={
          <span className="hud-label text-txt-dim tabular-nums">
            {located.length} plotted / {aircraft.length} tracked
          </span>
        }
      >
        <div className="relative" style={{ height: 460 }}>
          <MapView aircraft={located} />
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="hud-btn absolute right-2 top-2 z-[1200] bg-bg-elev/90"
            title="expand to fullscreen"
          >
            ⛶ EXPAND
          </button>
          <div className="pointer-events-none absolute bottom-2 left-2 z-[1200] hud-label bg-bg-strip/80 px-2 py-1 text-txt-dim">
            CARTO dark · rings 50/100/150nm · ▲ heading
          </div>
        </div>
      </Tile>

      {expanded &&
        createPortal(
          <div className="fixed inset-0 z-[2000] bg-bg-base">
            <div className="absolute inset-0">
              <MapView aircraft={located} fullscreen />
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="hud-btn hud-btn-danger absolute right-3 top-3 z-[2100] bg-bg-elev/90"
              title="close (Esc)"
            >
              ✕ CLOSE
            </button>
            <div className="pointer-events-none absolute left-3 top-3 z-[2100] hud-label bg-bg-strip/85 px-3 py-1 text-txt-dim">
              ADS-B · {located.length} plotted / {aircraft.length} tracked · ESC to exit
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// Leaflet chrome restyled to the phosphor HUD. Scoped here so index.css is
// untouched; only affects Leaflet elements, which exist solely on this map.
const MAP_CSS = `
.leaflet-container { background:#05070f; font-family:'IBM Plex Mono',ui-monospace,monospace; }
.leaflet-control-attribution { background:rgba(5,7,15,.72)!important; color:#4a5878!important; font-size:10px; }
.leaflet-control-attribution a { color:#7c8bb0!important; }
.leaflet-bar { border:none!important; }
.leaflet-bar a, .leaflet-bar a:focus {
  background:#0f1526; color:#9daecf; border:1px solid #1a2439;
  border-bottom-color:#1a2439;
}
.leaflet-bar a:hover { background:#1a2439; color:#ffb347; border-color:#c77700; }
.leaflet-touch .leaflet-bar a:first-child { border-top-left-radius:0; border-top-right-radius:0; }
.leaflet-touch .leaflet-bar a:last-child { border-bottom-left-radius:0; border-bottom-right-radius:0; }

.adsb-plane-wrap { position:relative; }
.adsb-plane-icon { display:block; color:#ffb347; filter:drop-shadow(0 0 3px rgba(255,179,71,.75)); transform-origin:11px 11px; }
.adsb-plane-wrap.adsb-stale .adsb-plane-icon { color:#4a5878; filter:none; opacity:.75; }
.adsb-plane-label {
  position:absolute; left:15px; top:0; white-space:nowrap;
  font-size:10px; line-height:13px; letter-spacing:.03em; color:#ffc569;
  background:rgba(5,7,15,.72); border:1px solid #2a3656; padding:0 3px;
  text-shadow:0 0 4px rgba(0,0,0,.9); pointer-events:none;
}
.adsb-plane-wrap.adsb-stale .adsb-plane-label { color:#6b7a9c; border-color:#1a2439; }

.adsb-recv-wrap { color:#a78bfa; filter:drop-shadow(0 0 5px rgba(167,139,250,.85)); }

.leaflet-popup-content-wrapper, .leaflet-popup-tip {
  background:#0a0e1c; color:#9daecf; border:1px solid #2a3656; border-radius:0;
  box-shadow:0 0 14px rgba(167,139,250,.28);
}
.leaflet-popup-content { margin:7px 11px; font-size:11px; line-height:1.5; }
.leaflet-popup-content .adsb-pop-h {
  color:#ffb347; font-weight:600; letter-spacing:.06em; text-transform:uppercase;
  margin-bottom:3px; font-size:11px;
}
.leaflet-popup-content .adsb-pop b { color:#c4b5fd; font-weight:600; }
.leaflet-container a.leaflet-popup-close-button { color:#4a5878; }
.leaflet-container a.leaflet-popup-close-button:hover { color:#ffb347; }

/* Full intel card — tar1090 parity, phosphor-HUD themed. */
.leaflet-popup-content .adsb-card { min-width:236px; max-height:340px; overflow-y:auto; padding-right:2px; }
.leaflet-popup-content .adsb-pop-sub { color:#9daecf; font-size:10.5px; line-height:1.45; }
.leaflet-popup-content .adsb-pop-sub.adsb-op { color:#7c8bb0; font-style:italic; }
.leaflet-popup-content .adsb-pop-sub b { color:#c4b5fd; }
.leaflet-popup-content .adsb-emrg { color:#ff5a7a; font-weight:700; letter-spacing:.04em; }
.leaflet-popup-content .adsb-chips { display:flex; flex-wrap:wrap; gap:3px; margin:4px 0 2px; }
.leaflet-popup-content .adsb-chip {
  font-size:9px; letter-spacing:.06em; font-weight:700; text-transform:uppercase;
  color:#05070f; background:#ffb347; padding:0 4px; line-height:14px; border-radius:0;
}
.leaflet-popup-content .adsb-chip.adsb-chip-off { color:#4a5878; background:transparent; border:1px solid #1a2439; font-weight:500; }
.leaflet-popup-content .adsb-sec-h {
  color:#a78bfa; font-size:9.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase;
  margin:7px 0 2px; padding-bottom:1px; border-bottom:1px solid #1a2439;
}
.leaflet-popup-content .adsb-grid {
  display:grid; grid-template-columns:auto 1fr; gap:1px 10px; font-size:10.5px; line-height:1.5;
}
.leaflet-popup-content .adsb-k { color:#6b7a9c; white-space:nowrap; }
.leaflet-popup-content .adsb-v { color:#cdd8ef; text-align:right; font-variant-numeric:tabular-nums; }
`;
