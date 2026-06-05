// GPS navigation screen — live fix, satellite sky view, chrony/PPS status,
// track recorder. Mirrors web/src/pages/Gps.tsx. Module id: gps.

import { Box, Text, useInput, useStdout } from "ink";
import { useState, type ReactNode } from "react";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { TEXT } from "../lib/theme.js";

// App-shell chrome (HUD bars + nav) consumed outside this screen.
const APP_CHROME = 8;
// Fixed rows above row2 (sat + chrony tiles):
//   ModuleHeader(1) + marginTop(1) + row1_tiles_max(7) + marginTop(1) = 10
const ROW1_CHROME = 10;
// Fixed rows in sat tile OUTSIDE the scrollable satellite list:
//   tile_borders+title(3) + col_header(1) + "+N more" indicator(1) = 5
const SAT_TILE_FIXED = 5;
// Fixed rows in chrony tile OUTSIDE the dynamic detail section:
//   tile_borders+title(3) + sep(1) + idle/rec(1) = 5
// detail rows fill the remainder.
const CHRONY_TILE_FIXED = 5;

// ── local response shapes ────────────────────────────────────────────────────

type FixResp = {
  ok: boolean;
  connected?: boolean;
  mode?: number | null;
  waiting?: string | null;
  lat?: number | null;
  lon?: number | null;
  alt?: number | null;
  speed_mps?: number | null;
  track_deg?: number | null;
  climb_mps?: number | null;
  time?: string | null;
  epx?: number | null;
  epy?: number | null;
  epv?: number | null;
  hdop?: number | null;
  vdop?: number | null;
  pdop?: number | null;
  satellites_seen?: number | null;
  satellites_used?: number | null;
  reason?: string;
};

type GpsSat = {
  prn?: number | null;
  constellation?: string;
  elevation?: number | null;
  azimuth?: number | null;
  snr?: number | null;
  used?: boolean;
};

type SatsResp = {
  ok: boolean;
  satellites?: GpsSat[];
  seen?: number;
  used?: number;
  reason?: string;
};

type TimeResp = {
  ok: boolean;
  tracking?: {
    ok?: boolean;
    stratum?: number;
    last_offset_s?: number;
    rms_offset_s?: number;
    reference_id?: string;
    reason?: string;
  };
  pps?: {
    device?: string;
    present?: boolean;
    pulsing?: boolean | null;
  };
};

type TrackRow = {
  filename?: string;
  name?: string;
  points?: number;
  distance_km?: number;
};

type TracksResp = {
  ok: boolean;
  tracks?: TrackRow[];
  recording?: {
    active?: boolean;
    started?: string | null;
    filename?: string | null;
    points?: number;
  };
};

// ── helpers ──────────────────────────────────────────────────────────────────

function modeLabel(mode: number): string {
  if (mode < 2) return "NO FIX";
  if (mode === 2) return "2D FIX";
  return "3D FIX";
}

function modeLed(mode: number) {
  if (mode < 2) return "pink" as const;
  if (mode === 2) return "amber" as const;
  return "mint" as const;
}

function fmt(n: number | null | undefined, dec: number): string {
  if (n == null) return "—";
  return n.toFixed(dec);
}

function fmtOffset(s?: number | null): string {
  if (s == null) return "—";
  const us = s * 1e6;
  const sign = us >= 0 ? "+" : "";
  if (Math.abs(us) < 1000) return `${sign}${us.toFixed(1)}µs`;
  return `${sign}${(s * 1e3).toFixed(3)}ms`;
}

// ── screen ───────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 120;

  const [satOffset, setSatOffset] = useState(0);

  const { data: fix, error: fixErr } = usePoll<FixResp>(
    () => api.get<FixResp>("/api/gps/fix"),
    2000,
    [api],
  );
  const { data: sats } = usePoll<SatsResp>(
    () => api.get<SatsResp>("/api/gps/sats"),
    3000,
    [api],
  );
  const { data: timeData } = usePoll<TimeResp>(
    () => api.get<TimeResp>("/api/gps/time"),
    5000,
    [api],
  );
  const { data: tracks } = usePoll<TracksResp>(
    () => api.get<TracksResp>("/api/gps/tracks"),
    5000,
    [api],
  );

  // Compute budgets before useInput — hooks must not appear after early returns.
  const body = Math.max(6, rows - APP_CHROME);
  const row2Budget = Math.max(4, body - ROW1_CHROME);
  const maxSats = Math.max(1, row2Budget - SAT_TILE_FIXED);
  // maxChronyDetail = how many detail rows (ref/offset/stratum/rms) fit besides
  // the fixed sep + idle/rec rows that are always shown.
  const maxChronyDetail = Math.max(0, row2Budget - CHRONY_TILE_FIXED);

  // Hoist sat list before useInput.
  const satList = sats?.satellites ?? [];
  const clampedSatOffset = Math.min(satOffset, Math.max(0, satList.length - maxSats));

  useInput((input, key) => {
    const maxOff = Math.max(0, satList.length - maxSats);
    if (input === "j" || key.downArrow) setSatOffset((o) => Math.min(o + 1, maxOff));
    if (input === "k" || key.upArrow) setSatOffset((o) => Math.max(0, o - 1));
  });

  if (fixErr && !fix) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ModuleHeader code="02 GPS-NAV" title="GPS Navigation" icon="🛰" state="ERROR" />
        <Box marginTop={1}>
          <Tile title="LINK ERROR" led="pink" width={60}>
            <Text color="#ef4444">  gps error — {fixErr}</Text>
          </Tile>
        </Box>
      </Box>
    );
  }

  if (!fix) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ModuleHeader code="02 GPS-NAV" title="GPS Navigation" icon="🛰" state="acquiring…" />
        <Box marginTop={1}>
          <Text color={TEXT.dim}>  acquiring gps telemetry…</Text>
        </Box>
      </Box>
    );
  }

  const mode = fix.mode ?? 0;
  const satUsed = fix.satellites_used ?? sats?.used ?? 0;
  const satSeen = fix.satellites_seen ?? sats?.seen ?? 0;
  const stateStr = `${modeLabel(mode)} ${satUsed}/${satSeen}sat`;
  const tracking = timeData?.tracking;
  const pps = timeData?.pps;
  const rec = tracks?.recording;
  const trackList = tracks?.tracks ?? [];

  // Dynamic tile widths bounded to terminal.
  const usable = cols - 2;
  const tileW = Math.max(22, Math.floor((usable - 3) / 4));
  const satTileW = Math.max(40, Math.floor((usable - 1) * 0.48));
  const chronyTileW = Math.max(28, usable - satTileW - 1);
  const sepLen = Math.max(6, chronyTileW - 10);

  // Satellite scroll window.
  const visibleSats = satList.slice(clampedSatOffset, clampedSatOffset + maxSats);
  const hiddenAbove = clampedSatOffset;
  const hiddenBelow = Math.max(0, satList.length - clampedSatOffset - maxSats);

  // Chrony detail items — show highest-priority ones first when space is tight.
  // Priority: offset (precision) → ref (source) → stratum (level) → rms (accuracy).
  const chronyDetails: ReactNode[] = [];
  if (tracking?.last_offset_s != null)
    chronyDetails.push(
      <Text key="off" color={TEXT.hi}>  offset  {fmtOffset(tracking.last_offset_s)}</Text>,
    );
  if (tracking?.reference_id)
    chronyDetails.push(
      <Text key="ref" color={TEXT.body}>  ref  {tracking.reference_id}</Text>,
    );
  if (tracking?.stratum != null)
    chronyDetails.push(
      <Text key="str" color={TEXT.body}>  stratum {tracking.stratum}</Text>,
    );
  if (tracking?.rms_offset_s != null)
    chronyDetails.push(
      <Text key="rms" color={TEXT.dim}>  rms     {fmtOffset(tracking.rms_offset_s)}</Text>,
    );
  const visibleChronyDetails = chronyDetails.slice(0, maxChronyDetail);

  return (
    <Box flexDirection="column" paddingX={1}>
      <ModuleHeader
        code="02 GPS-NAV"
        title="GPS Navigation"
        icon="🛰"
        state={stateStr}
        right={
          fix.lat != null ? (
            <Text color={TEXT.body}>
              {fmt(fix.lat, 5)}°N  {fmt(fix.lon, 5)}°E
            </Text>
          ) : undefined
        }
      />

      {/* ── row 1: position / altitude / velocity / time ── */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Tile title="POSITION" led={modeLed(mode)} width={tileW}>
          {fix.lat != null ? (
            <>
              <BigValue value={fmt(fix.lat, 5)} unit="°N" />
              <BigValue value={fmt(fix.lon, 5)} unit="°E" />
              {fix.hdop != null && (
                <Text color={TEXT.dim}>  hdop {fix.hdop.toFixed(1)}</Text>
              )}
            </>
          ) : (
            <Text color={TEXT.dim}>  {fix.waiting ?? "no fix"}</Text>
          )}
        </Tile>

        <Tile title="ALTITUDE" led={modeLed(mode)} width={tileW}>
          {fix.alt != null ? (
            <>
              <BigValue value={Math.round(fix.alt * 3.28084).toString()} unit="ft" />
              <Text color={TEXT.dim}>  {fmt(fix.alt, 1)} m MSL</Text>
              {fix.epv != null && (
                <Text color={TEXT.dim}>  ±{fmt(fix.epv, 1)} m</Text>
              )}
            </>
          ) : (
            <Text color={TEXT.dim}>  no altitude</Text>
          )}
        </Tile>

        <Tile title="VELOCITY" led={modeLed(mode)} width={tileW}>
          {fix.speed_mps != null ? (
            <>
              <BigValue value={fmt(fix.speed_mps * 1.94384, 1)} unit="kt" />
              {fix.track_deg != null && (
                <Text color={TEXT.dim}>  {fmt(fix.track_deg, 0)}° track</Text>
              )}
              {fix.climb_mps != null && (
                <Text color={TEXT.dim}>  {Math.round(fix.climb_mps * 196.85)} fpm</Text>
              )}
            </>
          ) : (
            <Text color={TEXT.dim}>  no velocity</Text>
          )}
        </Tile>

        <Tile title="GPS TIME" led={tracking?.ok ? "mint" : "amber"} width={tileW}>
          {fix.time ? (
            <Text color={TEXT.hi}>  {fix.time.substring(11, 19)}Z</Text>
          ) : (
            <Text color={TEXT.dim}>  —</Text>
          )}
          {tracking?.stratum != null && (
            <Text color={TEXT.dim}>  stratum {tracking.stratum}</Text>
          )}
          {tracking?.last_offset_s != null && (
            <Text color={TEXT.body}>  {fmtOffset(tracking.last_offset_s)}</Text>
          )}
          {pps?.present && (
            <Text color={pps.pulsing ? "#4ade80" : TEXT.dim}>
              {"  "}PPS {pps.pulsing ? "◉" : "○"} {pps.device ?? "/dev/pps0"}
            </Text>
          )}
        </Tile>
      </Box>

      {/* ── row 2: satellite sky view + chrony/tracks ── */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Tile
          title={`SATELLITES (${satUsed}/${satSeen})`}
          led={satUsed > 4 ? "mint" : satUsed > 0 ? "amber" : "dim"}
          width={satTileW}
        >
          <Box flexDirection="row">
            <Text color={TEXT.dim}>{"PRN ".padEnd(5)}</Text>
            <Text color={TEXT.dim}>{"CONST    ".padEnd(10)}</Text>
            <Text color={TEXT.dim}>{"EL ".padEnd(4)}</Text>
            <Text color={TEXT.dim}>{"AZ  ".padEnd(5)}</Text>
            <Text color={TEXT.dim}>{"SNR".padEnd(5)}</Text>
          </Box>
          {hiddenAbove > 0 && (
            <Text color={TEXT.dim}>  ↑{hiddenAbove} above</Text>
          )}
          {visibleSats.map((s, i) => (
            <Box key={i} flexDirection="row">
              <Text color={TEXT.hi}>{String(s.prn ?? "?").padStart(3) + "  "}</Text>
              <Text color={TEXT.body}>{(s.constellation ?? "?").padEnd(10)}</Text>
              <Text color={TEXT.dim}>{String(s.elevation ?? "—").padStart(3) + " "}</Text>
              <Text color={TEXT.dim}>{String(s.azimuth ?? "—").padStart(4) + " "}</Text>
              <Text color={s.used ? "#4ade80" : TEXT.dim}>
                {String(s.snr ?? "—").padStart(3)} {s.used ? "◆" : "○"}
              </Text>
            </Box>
          ))}
          {hiddenBelow > 0 && (
            <Text color={TEXT.dim}>  +{hiddenBelow} more  j/k scroll</Text>
          )}
          {satList.length === 0 && (
            <Text color={TEXT.dim}>  awaiting sky view…</Text>
          )}
        </Tile>

        <Tile title="CHRONY / TRACKS" led={tracking?.ok ? "mint" : "dim"} width={chronyTileW}>
          {tracking ? (
            <>{visibleChronyDetails}</>
          ) : (
            <Text color={TEXT.dim}>  chrony —</Text>
          )}
          <Text color={TEXT.dim}>  {"─".repeat(sepLen)}</Text>
          {rec?.active ? (
            <Text color="#f472b6">
              {"  "}◉ REC  {rec.filename ?? ""}  {rec.points ?? 0} pts
            </Text>
          ) : (
            <Text color={TEXT.dim}>
              {"  "}○ idle  {trackList.length} track{trackList.length === 1 ? "" : "s"}
            </Text>
          )}
        </Tile>
      </Box>
    </Box>
  );
}
