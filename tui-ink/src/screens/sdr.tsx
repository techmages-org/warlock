// SDR scanner screen — device status, ADS-B aircraft table, rtl_433 events,
// frequency presets. Mirrors web/src/pages/Sdr.tsx. Module id: sdr.

import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import type { Aircraft } from "../lib/types.js";
import { TEXT } from "../lib/theme.js";

// Chrome rows consumed by header + status tile row + aircraft tile frame + col headers
const ACFT_CHROME = 14;

// ── Receiver position (Granger TX) for haversine distance ────────────────────
const RX_LAT = 30.7188;
const RX_LON = -97.4436;

function haversineNm(lat: number, lon: number): number {
  const R = 3440.065; // Earth radius in nautical miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat - RX_LAT);
  const dLon = toRad(lon - RX_LON);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(RX_LAT)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── local response shapes ─────────────────────────────────────────────────────

type SdrStatus = {
  ok: boolean;
  rtl_sdr_detected?: boolean;
  tuner?: string | null;
  device_count?: number;
  usb_present?: boolean;
  blacklist?: { present: boolean };
  readsb?: { active: boolean };
  rtl_433?: { active: boolean };
  lock?: { holder: string | null };
};

type AircraftResp = {
  ok: boolean;
  count?: number;
  aircraft?: Aircraft[];
  reason?: string;
};

type Rtl433Event = {
  time?: string;
  model?: string;
  id?: number;
  channel?: number;
  temperature_C?: number;
  humidity?: number;
};

type Rtl433Resp = {
  ok: boolean;
  events?: Rtl433Event[];
  running?: boolean;
};

type Preset = {
  id: string;
  label: string;
  freq_mhz: number;
  mode: string;
  bw_khz: number;
};

type PresetsResp = {
  ok: boolean;
  presets?: Preset[];
};

type AircraftRow = Aircraft & { distance_nm?: number };

const TILE_W = 28;

// ── screen ────────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 120;

  const [acftOffset, setAcftOffset] = useState(0);

  const { data: status, error: statusErr } = usePoll<SdrStatus>(
    () => api.get<SdrStatus>("/api/sdr/status"),
    3000,
    [api],
  );
  const { data: acftResp } = usePoll<AircraftResp>(
    () => api.get<AircraftResp>("/api/sdr/adsb/aircraft"),
    3000,
    [api],
  );
  const { data: eventsResp } = usePoll<Rtl433Resp>(
    () => api.get<Rtl433Resp>("/api/sdr/rtl433/events"),
    3000,
    [api],
  );
  const { data: presetsResp } = usePoll<PresetsResp>(
    () => api.get<PresetsResp>("/api/sdr/presets"),
    10000,
    [api],
  );

  // Hoist aircraft derivation before useInput.
  const rawAircraft: AircraftRow[] = (acftResp?.aircraft ?? []).map((a) => ({
    ...a,
    distance_nm:
      a.lat != null && a.lon != null ? haversineNm(a.lat, a.lon) : undefined,
  }));
  rawAircraft.sort((a, b) => (a.distance_nm ?? 9999) - (b.distance_nm ?? 9999));

  const maxAcft = Math.max(2, rows - ACFT_CHROME);
  const clampedAcftOffset = Math.min(
    acftOffset,
    Math.max(0, rawAircraft.length - maxAcft),
  );

  useInput((input, key) => {
    const maxOff = Math.max(0, rawAircraft.length - maxAcft);
    if (input === "j" || key.downArrow) setAcftOffset((o) => Math.min(o + 1, maxOff));
    if (input === "k" || key.upArrow) setAcftOffset((o) => Math.max(0, o - 1));
  });

  if (statusErr && !status) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ModuleHeader code="04 SDR-SCN" title="SDR Scanner" icon="∿" state="ERROR" />
        <Box marginTop={1}>
          <Tile title="LINK ERROR" led="pink" width={60}>
            <Text color="#ef4444">  sdr error — {statusErr}</Text>
          </Tile>
        </Box>
      </Box>
    );
  }

  if (!status) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ModuleHeader code="04 SDR-SCN" title="SDR Scanner" icon="∿" state="acquiring…" />
        <Box marginTop={1}>
          <Text color={TEXT.dim}>  acquiring sdr status…</Text>
        </Box>
      </Box>
    );
  }

  // Compute dynamic table widths from cols
  const usable = cols - 2; // paddingX=1 on each side
  const evtTableW = Math.max(24, Math.floor(usable * 0.34));
  const acftTableW = Math.max(50, usable - evtTableW - 1);

  const events = eventsResp?.events ?? [];
  const presets = presetsResp?.presets ?? [];
  const acftCount = acftResp?.count ?? rawAircraft.length;
  const evtCount = events.length;

  const deviceLed = status.rtl_sdr_detected ? ("mint" as const) : ("pink" as const);
  const adsbLed = status.readsb?.active ? ("mint" as const) : ("dim" as const);
  const rtlLed = status.rtl_433?.active ? ("mint" as const) : ("dim" as const);

  // Aircraft scroll window
  const visibleAcft = rawAircraft.slice(clampedAcftOffset, clampedAcftOffset + maxAcft);
  const hiddenAbove = clampedAcftOffset;
  const hiddenBelow = Math.max(0, rawAircraft.length - clampedAcftOffset - maxAcft);

  return (
    <Box flexDirection="column" paddingX={1}>
      <ModuleHeader
        code="04 SDR-SCN"
        title="SDR Scanner"
        icon="∿"
        state={`${acftCount} acft / ${evtCount} evt`}
        right={
          status.tuner ? (
            <Text color={TEXT.dim}>{status.tuner}</Text>
          ) : undefined
        }
      />

      {/* ── row 1: 4 status tiles ── */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Tile title="SDR DEVICE" led={deviceLed} width={TILE_W}>
          <BigValue value={status.device_count ?? 0} unit="dev" color={deviceLed} />
          {status.tuner ? (
            <Text color={TEXT.body}>  {status.tuner.substring(0, 22)}</Text>
          ) : (
            <Text color={TEXT.dim}>  no tuner</Text>
          )}
          {status.lock?.holder && (
            <Text color={TEXT.dim}>  lock: {status.lock.holder}</Text>
          )}
        </Tile>

        <Tile title="ADS-B" led={adsbLed} width={TILE_W}>
          <BigValue value={acftCount} unit="aircraft" color={adsbLed} />
          <Text color={status.readsb?.active ? "#4ade80" : TEXT.dim}>
            {"  "}{status.readsb?.active ? "◉ running" : "○ stopped"}
          </Text>
          {!acftResp?.ok && acftResp?.reason && (
            <Text color={TEXT.dim}>  {acftResp.reason.substring(0, 22)}</Text>
          )}
        </Tile>

        <Tile title="RTL_433" led={rtlLed} width={TILE_W}>
          <BigValue value={evtCount} unit="events" color={rtlLed} />
          <Text color={status.rtl_433?.active ? "#4ade80" : TEXT.dim}>
            {"  "}{status.rtl_433?.active ? "◉ running" : "○ stopped"}
          </Text>
        </Tile>

        <Tile title="PRESETS" led="violet" width={TILE_W}>
          <BigValue value={presets.length} unit="presets" color="violet" />
          {presets.slice(0, 2).map((p) => (
            <Text key={p.id} color={TEXT.dim}>
              {"  "}{p.freq_mhz.toFixed(2)} {p.mode}
            </Text>
          ))}
        </Tile>
      </Box>

      {/* ── row 2: aircraft table + rtl_433 events ── */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        {/* ADS-B aircraft table */}
        <Tile title="ADS-B AIRCRAFT" led={adsbLed} width={acftTableW}>
          <Box flexDirection="row">
            <Text color={TEXT.dim}>{"CALLSIGN ".padEnd(10)}</Text>
            <Text color={TEXT.dim}>{"ICAO  ".padEnd(7)}</Text>
            <Text color={TEXT.dim}>{"ALT    ".padEnd(8)}</Text>
            <Text color={TEXT.dim}>{"GS  ".padEnd(5)}</Text>
            <Text color={TEXT.dim}>{"HDG ".padEnd(5)}</Text>
            <Text color={TEXT.dim}>DIST</Text>
          </Box>
          {hiddenAbove > 0 && (
            <Text color={TEXT.dim}>  ↑{hiddenAbove} above</Text>
          )}
          {visibleAcft.map((a, i) => {
            const cs = (a.callsign ?? "———").substring(0, 9).padEnd(9);
            const icao = (a.icao ?? "——").padEnd(6);
            const alt =
              a.altitude_ft != null
                ? String(Math.round(a.altitude_ft)).padStart(6)
                : "    —";
            const gs =
              a.speed_kt != null
                ? String(Math.round(a.speed_kt)).padStart(4)
                : "   —";
            const hdg =
              a.heading != null
                ? String(Math.round(a.heading)).padStart(3)
                : "  —";
            const dist =
              a.distance_nm != null
                ? a.distance_nm.toFixed(1).padStart(5) + "nm"
                : "    —";
            return (
              <Box key={i} flexDirection="row">
                <Text color={TEXT.hi}> {cs} </Text>
                <Text color={TEXT.dim}>{icao} </Text>
                <Text color={TEXT.body}>{alt}ft </Text>
                <Text color={TEXT.dim}>{gs}kt </Text>
                <Text color={TEXT.dim}>{hdg}° </Text>
                <Text color={TEXT.body}>{dist}</Text>
              </Box>
            );
          })}
          {rawAircraft.length === 0 && (
            <Text color={TEXT.dim}>
              {"  "}{status.readsb?.active ? "no aircraft in range" : "readsb stopped"}
            </Text>
          )}
          {hiddenBelow > 0 && (
            <Text color={TEXT.dim}>  +{hiddenBelow} more  j/k scroll</Text>
          )}
        </Tile>

        {/* RTL_433 events */}
        <Tile title="RTL_433 EVENTS" led={rtlLed} width={evtTableW}>
          {events.length === 0 ? (
            <Text color={TEXT.dim}>
              {"  "}{eventsResp?.running ? "listening…" : "not running"}
            </Text>
          ) : (
            events.slice(-maxAcft).map((e, i) => {
              const ts = (e.time ?? "").substring(11, 19);
              const label = (e.model ?? "unknown").substring(0, 20);
              return (
                <Box key={i} flexDirection="row">
                  <Text color={TEXT.dim}> {ts} </Text>
                  <Text color={TEXT.hi}>{label}</Text>
                </Box>
              );
            })
          )}
        </Tile>
      </Box>
    </Box>
  );
}
