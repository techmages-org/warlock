// Native in-app ADS-B map for the SDR module. Phosphor-HUD themed Leaflet map
// (CARTO dark-matter tiles — no API key) plotting live aircraft as heading-
// rotated plane glyphs, centred on the Granger TX receiver, with a
// click-to-expand fullscreen view. Aircraft data is fed in from the parent
// Sdr poll loop (no extra fetch here). All Leaflet style overrides live in the
// <style> block below so this stays self-contained.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Tile } from "./hud";

// Receiver site — Granger, TX. The map always centres here.
export const RECEIVER = { lat: 30.7188, lon: -97.4436 } as const;

// Subset of the SDR Aircraft shape the map needs (structurally compatible).
export type MapAircraft = {
  icao: string;
  callsign: string | null;
  altitude_ft: number | null;
  speed_kt: number | null;
  heading: number | null;
  lat: number | null;
  lon: number | null;
  seen_s: number | null;
  squawk: string | null;
};

const NM = 1852; // metres per nautical mile — for range rings.

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
  const alt = a.altitude_ft != null ? `${a.altitude_ft.toLocaleString()}ft` : "";
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
            <div className="adsb-pop">
              <div className="adsb-pop-h">{a.callsign?.trim() || a.icao}</div>
              <div>icao <b>{a.icao}</b>{a.squawk ? ` · sq ${a.squawk}` : ""}</div>
              <div>
                alt {a.altitude_ft != null ? `${a.altitude_ft.toLocaleString()} ft` : "—"}
                {" · "}gs {a.speed_kt != null ? `${a.speed_kt} kt` : "—"}
              </div>
              <div>
                hdg {a.heading != null ? `${a.heading}°` : "—"}
                {" · "}seen {a.seen_s != null ? `${a.seen_s}s` : "—"}
              </div>
            </div>
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
`;
