// ============================================================================
// DASHBOARD — the FULL reference screen. This is the pattern W1–W4 replicate
// for every other screen. Anatomy:
//   1. useApi() to get the shared, auth'd client from context (never `new`).
//   2. usePoll() to fetch the module's endpoint on an interval.
//   3. Render: ModuleHeader + loading/error guards + a compact grid of Tiles.
//   4. Keep it SHORT — uConsole CM5 is 1280×480 (~120 cols × ~24 rows); prefer
//      wide rows of small tiles over tall vertical stacks.
//   5. A co-located dashboard.test.tsx proves it with a mocked client + a live
//      lastFrame() assertion (see README "How to add a screen").
// Mirrors web/src/pages/Dashboard.tsx field-for-field (same DashboardStatus).
// ============================================================================

import { Box, Text } from "ink";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, severityLed, TEXT, type LEDColor } from "../lib/theme.js";
import type { DashboardStatus } from "../lib/types.js";

const TILE_W = 28;

type ThrottleState = { color: LEDColor; label: string };

// Raspberry Pi `vcgencmd get_throttled` bitfield as a hex string. Low nibble
// (bits 0-3) = throttling NOW; high bits (0x10000+) = sticky "since boot".
// Live first so a value with both reads RED. (Ported from web Dashboard.)
function throttleState(throttled: string | null): ThrottleState | null {
  if (throttled == null) return null;
  // Backend sends "throttled=0x0"; accept both that and a bare "0x0".
  const hex = throttled.includes("=") ? throttled.split("=")[1] : throttled;
  const v = parseInt(hex, 16);
  if (Number.isNaN(v)) return null;
  const live = v & 0xf;
  const sticky = v & 0xffff0000;
  if (live) return { color: "pink", label: "THROTTLING NOW" };
  if (sticky) return { color: "amber", label: "THROTTLED EARLIER" };
  return { color: "mint", label: "OK" };
}

export function Screen() {
  const api = useApi();
  const { data: s, error } = usePoll<DashboardStatus>(
    () => api.get<DashboardStatus>("/api/dashboard/status"),
    2000,
    [api],
  );

  if (error) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="00 SYS-HUD" title="Command Dashboard" state="LINK ERROR" icon="●" />
        <Tile title="ERROR" led="pink" width={TILE_W * 2}>
          <Text color={COLORS.pink}>dashboard error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  if (!s) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="00 SYS-HUD" title="Command Dashboard" state="ACQUIRING" icon="●" />
        <Tile title="BOOT" led="amber" width={TILE_W}>
          <Text color={TEXT.dim}>acquiring telemetry…</Text>
        </Tile>
      </Box>
    );
  }

  const tempSev =
    s.temp_f == null ? "warn" : s.temp_f > 176 ? "err" : s.temp_f > 158 ? "warn" : "ok";
  const throttle = throttleState(s.throttled);
  // Only LIVE throttling turns the temp tile red; sticky/historical bits stay amber.
  const tempLed: LEDColor = throttle?.color === "pink" ? "pink" : severityLed(tempSev);
  const diskSev = s.disk_root_percent > 90 ? "err" : s.disk_root_percent > 80 ? "warn" : "ok";
  const cpuSev = s.cpu.percent > 90 ? "err" : s.cpu.percent > 70 ? "warn" : "ok";
  const memSev = s.memory.percent > 90 ? "err" : s.memory.percent > 80 ? "warn" : "ok";
  const chronyLed: LEDColor = s.chrony.ok ? "mint" : "amber";
  const gpsFix = !!s.gps.ok && (s.gps.mode ?? 0) >= 2;
  const gpsLed: LEDColor = gpsFix ? "mint" : "amber";
  const meshLed: LEDColor = s.mesh_node_count == null ? "amber" : "mint";
  const sdrLed: LEDColor = s.sdr.ok ? "mint" : "amber";
  const periphLed: LEDColor =
    gpsLed === "mint" && meshLed === "mint" && sdrLed === "mint" ? "mint" : "amber";
  const engagedLed: LEDColor = s.engagement.mode === "on" ? "pink" : "mint";

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="00 SYS-HUD"
        title="Command Dashboard"
        state={s.engagement.mode === "on" ? "ENGAGED" : "NOMINAL"}
        icon="●"
        right={
          <Text color={TEXT.dim}>
            {s.hostname} · {s.cpu.count} cores · {s.nmcli_active.length} links
          </Text>
        }
      />

      {/* Row 1: CPU · TEMP · MEM · DISK */}
      <Box>
        <Tile title="CPU LOAD" led={severityLed(cpuSev)} width={TILE_W}>
          <BigValue value={s.cpu.percent.toFixed(0)} unit="%" color={cpuSev === "err" ? "pink" : "amber"} />
          <Text color={TEXT.dim}>
            load {s.cpu.load_1m.toFixed(2)} · {s.cpu.load_5m.toFixed(2)} · {s.cpu.load_15m.toFixed(2)}
          </Text>
        </Tile>
        <Tile title="CORE TEMP" led={tempLed} width={TILE_W}>
          <BigValue
            value={s.temp_f != null ? s.temp_f.toFixed(1) : "—"}
            unit="°F"
            color={tempSev === "err" ? "pink" : "amber"}
          />
          <Text color={TEXT.dim}>
            {s.temp_c != null ? `${s.temp_c.toFixed(1)} °C` : "sensor offline"}
            {throttle && throttle.color !== "mint" ? `  ${throttle.label}` : ""}
          </Text>
        </Tile>
        <Tile title="MEMORY" led={severityLed(memSev)} width={TILE_W}>
          <BigValue value={s.memory.percent.toFixed(0)} unit="%" color="amber" />
          <Text color={TEXT.dim}>
            {s.memory.available_mb.toFixed(0)} / {s.memory.total_mb.toFixed(0)} MB free
          </Text>
        </Tile>
        <Tile title="DISK /" led={severityLed(diskSev)} width={TILE_W}>
          <BigValue
            value={(s.disk_root_mb_free / 1024 / 1024).toFixed(2)}
            unit="TB free"
            color={diskSev === "err" ? "pink" : "amber"}
          />
          <Text color={TEXT.dim}>{s.disk_root_percent}% used</Text>
        </Tile>
      </Box>

      {/* Row 2: CHRONY · ENGAGEMENT · RTC · LINKS */}
      <Box>
        <Tile title="CHRONY / NTP" led={chronyLed} width={TILE_W}>
          <BigValue
            value={s.chrony.ok ? `stratum ${s.chrony.stratum ?? "?"}` : "offline"}
            color={s.chrony.ok ? "mint" : "amber"}
          />
          <Text color={TEXT.dim}>
            {s.chrony.ok
              ? `offset ${s.chrony.offset_s != null ? s.chrony.offset_s.toExponential(1) : "?"}s`
              : s.chrony.reason ?? "no reason"}
          </Text>
        </Tile>
        <Tile title="ENGAGEMENT" led={engagedLed} width={TILE_W}>
          <BigValue
            value={s.engagement.mode === "on" ? "ENGAGED" : "SAFE"}
            color={s.engagement.mode === "on" ? "pink" : "mint"}
          />
          <Text color={TEXT.dim}>{s.engagement.name || "no engagement"}</Text>
        </Tile>
        <Tile title="RTC DRIFT" led="dim" width={TILE_W}>
          <BigValue value={s.rtc_drift_s != null ? `${s.rtc_drift_s}` : "—"} unit="s" color="amber" />
          <Text color={TEXT.dim}>hwclock − system</Text>
        </Tile>
        <Tile title="ACTIVE LINKS" led={s.nmcli_active.length > 0 ? "mint" : "amber"} width={TILE_W}>
          <BigValue value={s.nmcli_active.length} unit="iface" color="violet" />
          <Text color={TEXT.dim} wrap="truncate-end">
            {s.nmcli_active.map((a) => a.device).join(" · ") || "no active links"}
          </Text>
        </Tile>
      </Box>

      {/* Peripherals roll-up: GPS · MESH · SDR (each is its own module tab too) */}
      <Tile title="PERIPHERALS" led={periphLed} width={TILE_W * 2}>
        <Box>
          <StatusLED color={gpsLed} />
          <Text color={TEXT.body}> GPS </Text>
          <Text color={TEXT.dim}>
            {gpsFix ? `${s.gps.mode}D ${s.gps.lat?.toFixed(3)},${s.gps.lon?.toFixed(3)}` : s.gps.reason ?? "no fix"}
          </Text>
          <Text color={TEXT.dim}>   </Text>
          <StatusLED color={meshLed} />
          <Text color={TEXT.body}> MESH </Text>
          <Text color={TEXT.dim}>
            {s.mesh_node_count == null ? "unreachable" : `${s.mesh_node_count} nodes`}
          </Text>
          <Text color={TEXT.dim}>   </Text>
          <StatusLED color={sdrLed} />
          <Text color={TEXT.body}> SDR </Text>
          <Text color={TEXT.dim}>{s.sdr.ok ? `${s.sdr.count ?? 0} dev` : s.sdr.reason ?? "—"}</Text>
        </Box>
      </Tile>
    </Box>
  );
}
