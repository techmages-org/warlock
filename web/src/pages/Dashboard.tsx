import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, type DashboardStatus } from "../lib/api";
import {
  BigValue,
  MiniSparkline,
  ModuleHeader,
  StatusLED,
  Tile,
  type LEDColor,
} from "../components/hud"
import { AudioSettings } from "../components/AudioSettings";

type Status = DashboardStatus | null;

type ThrottleState = { color: "mint" | "amber" | "pink"; label: string };

// Raspberry Pi `vcgencmd get_throttled` bitfield, delivered as a hex string.
// The LOW nibble (bits 0-3) = LIVE conditions happening RIGHT NOW:
//   bit0 under-voltage · bit1 arm-freq-capped · bit2 currently-throttled · bit3 soft-temp-limit
// The HIGH bits (0x10000+) = STICKY "has occurred since boot" history (recovered now).
// 3-state: GREEN when clean, RED when any live bit is set, AMBER when only the
// historical bits remain — i.e. "throttled earlier, fine now". Live is checked
// first so a value with both live + sticky bits reads RED.
//
//   "0x0"     -> v=0x0      -> live=0x0, sticky=0x0      -> GREEN/mint  "OK"
//   "0xe0000" -> v=0xE0000  -> live=0x0, sticky=0xE0000  -> AMBER       "THROTTLED EARLIER"
//   "0x5"     -> v=0x5      -> live=0x5 (b0+b2)          -> RED/pink    "THROTTLING NOW"
function throttleState(throttled: string | null): ThrottleState | null {
  if (throttled == null) return null;
  const v = parseInt(throttled, 16);
  if (Number.isNaN(v)) return null;
  const live = v & 0xf; // bits 0-3: throttling NOW
  const sticky = v & 0xffff0000; // bits 16+: occurred since boot
  if (live) return { color: "pink", label: "THROTTLING NOW" };
  if (sticky) return { color: "amber", label: "THROTTLED EARLIER" };
  return { color: "mint", label: "OK" };
}

const THROTTLE_TEXT: Record<ThrottleState["color"], string> = {
  mint: "text-mint-safe",
  amber: "text-amber-base",
  pink: "text-pink-alert",
};

function useTrend(value: number | null | undefined, size = 20) {
  // Keep a small ring buffer of the most recent numeric samples for sparklines.
  const buf = useRef<number[]>([]);
  const [snapshot, setSnapshot] = useState<number[]>([]);
  useEffect(() => {
    if (value == null || Number.isNaN(value)) return;
    const next = [...buf.current, value].slice(-size);
    buf.current = next;
    setSnapshot(next);
  }, [value, size]);
  return snapshot;
}

function severityLed(severity: "ok" | "warn" | "err" | "dim"): LEDColor {
  switch (severity) {
    case "ok": return "mint";
    case "warn": return "amber";
    case "err": return "pink";
    case "dim": return "dim";
  }
}

export function Dashboard() {
  const [s, setStatus] = useState<Status>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await apiGet<DashboardStatus>("/api/dashboard/status");
        if (alive) { setStatus(r); setErr(null); }
      } catch (e: unknown) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const cpuTrend = useTrend(s?.cpu.percent);
  const memTrend = useTrend(s?.memory.percent);
  const tempTrend = useTrend(s?.temp_f ?? null);

  if (err) {
    return (
      <div>
        <ModuleHeader code="00 SYS-HUD" title="Command Dashboard" state="LINK ERROR" icon="●" />
        <Tile title="ERROR" led="pink" cornerColor="var(--pink-alert)">
          <div className="text-pink-alert">dashboard error: {err}</div>
        </Tile>
      </div>
    );
  }

  if (!s) {
    return (
      <div>
        <ModuleHeader code="00 SYS-HUD" title="Command Dashboard" state="ACQUIRING" icon="●" />
        <Tile title="BOOT" led="amber">
          <div className="text-txt-dim">acquiring telemetry…</div>
        </Tile>
      </div>
    );
  }

  const tempSev =
    s.temp_f == null ? "warn" : s.temp_f > 176 ? "err" : s.temp_f > 158 ? "warn" : "ok";
  const throttle = throttleState(s.throttled);
  // Escalate the temp-card LED to red only when LIVE-throttling — sticky/historical
  // bits must NOT turn the deck red (that was the false-red Jason flagged).
  const tempLed: LEDColor = throttle?.color === "pink" ? "pink" : severityLed(tempSev);
  const diskSev =
    s.disk_root_percent > 90 ? "err" : s.disk_root_percent > 80 ? "warn" : "ok";
  const cpuSev =
    s.cpu.percent > 90 ? "err" : s.cpu.percent > 70 ? "warn" : "ok";
  const memSev =
    s.memory.percent > 90 ? "err" : s.memory.percent > 80 ? "warn" : "ok";
  const chronyLed: LEDColor = s.chrony.ok ? "mint" : "amber";
  const gpsFix = s.gps.ok && (s.gps.mode ?? 0) >= 2;
  const gpsLed: LEDColor = gpsFix ? "mint" : "amber";
  const meshLed: LEDColor = s.mesh_node_count == null ? "amber" : "mint";
  const sdrLed: LEDColor = s.sdr.ok ? "mint" : "amber";
  // Roll the three tab-backed subsystems up into one at-a-glance LED.
  const periphLed: LEDColor =
    gpsLed === "mint" && meshLed === "mint" && sdrLed === "mint" ? "mint" : "amber";
  const engagedLed: LEDColor = s.engagement.mode === "on" ? "pink" : "mint";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="00 SYS-HUD"
        title="Command Dashboard"
        state={s.engagement.mode === "on" ? "ENGAGED" : "NOMINAL"}
        icon="●"
        right={
          <span className="hud-label text-txt-dim">
            {s.hostname} · {s.cpu.count} cores · {s.nmcli_active.length} links
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Tile title="CPU LOAD" led={severityLed(cpuSev)} headerRight={<MiniSparkline data={cpuTrend} />}>
          <BigValue value={`${s.cpu.percent.toFixed(0)}`} unit="%" color={cpuSev === "err" ? "pink" : cpuSev === "warn" ? "amber" : "amber"} flashOnChange />
          <div className="mt-2 text-txt-dim">
            load <span className="text-txt-body tabular-nums">{s.cpu.load_1m.toFixed(2)}</span>
            <span className="mx-1 text-txt-dim">·</span>
            <span className="text-txt-body tabular-nums">{s.cpu.load_5m.toFixed(2)}</span>
            <span className="mx-1 text-txt-dim">·</span>
            <span className="text-txt-body tabular-nums">{s.cpu.load_15m.toFixed(2)}</span>
          </div>
        </Tile>

        <Tile title="CORE TEMP" led={tempLed} headerRight={<MiniSparkline data={tempTrend} color="var(--amber-base)" />}>
          <BigValue
            value={s.temp_f != null ? `${s.temp_f.toFixed(1)}` : "—"}
            unit="°F"
            color={tempSev === "err" ? "pink" : tempSev === "warn" ? "amber" : "amber"}
            flashOnChange
          />
          <div className="mt-2 text-txt-dim">
            {s.temp_c != null ? `${s.temp_c.toFixed(1)} °C` : "sensor offline"}
            {throttle ? (
              <span className={`ml-2 ${THROTTLE_TEXT[throttle.color]}`}>
                {throttle.label}
                {s.throttled ? <span className="ml-1 text-txt-dim tabular-nums">{s.throttled}</span> : null}
              </span>
            ) : null}
          </div>
        </Tile>

        <Tile title="MEMORY" led={severityLed(memSev)} headerRight={<MiniSparkline data={memTrend} />}>
          <BigValue value={`${s.memory.percent.toFixed(0)}`} unit="%" color="amber" flashOnChange />
          <div className="mt-2 text-txt-dim">
            {s.memory.available_mb} MB free / {s.memory.total_mb} MB
          </div>
        </Tile>

        <Tile title="DISK /" led={severityLed(diskSev)}>
          <BigValue value={(s.disk_root_mb_free / 1024 / 1024).toFixed(2)} unit="TB free" color={diskSev === "err" ? "pink" : "amber"} flashOnChange />
          <div className="mt-2 text-txt-dim">
            {s.disk_root_percent}% used
          </div>
        </Tile>

        <Tile title="CHRONY / NTP" led={chronyLed}>
          <BigValue
            value={s.chrony.ok ? `stratum ${s.chrony.stratum ?? "?"}` : "offline"}
            color={s.chrony.ok ? "mint" : "amber"}
            size="md"
          />
          <div className="mt-2 text-txt-dim">
            {s.chrony.ok
              ? <>offset <span className="text-cyan-signal tabular-nums">{s.chrony.offset_s != null ? s.chrony.offset_s.toExponential(2) : "?"}</span> s · {s.chrony.source ?? ""}</>
              : s.chrony.reason ?? "no reason"}
          </div>
        </Tile>

        <Tile title="ENGAGEMENT" led={engagedLed} cornerColor={s.engagement.mode === "on" ? "var(--pink-alert)" : undefined}>
          <BigValue
            value={s.engagement.mode === "on" ? "ENGAGED" : "SAFE"}
            color={s.engagement.mode === "on" ? "pink" : "mint"}
            size="md"
          />
          <div className="mt-2 text-txt-dim truncate">
            {s.engagement.name || "no engagement"}
          </div>
        </Tile>

        <Tile title="RTC DRIFT" led="dim">
          <BigValue
            value={s.rtc_drift_s != null ? `${s.rtc_drift_s}` : "—"}
            unit="s"
            color="amber"
            flashOnChange
          />
          <div className="mt-2 text-txt-dim">hwclock − system</div>
        </Tile>

        <Tile title="ACTIVE LINKS" led={s.nmcli_active.length > 0 ? "mint" : "amber"}>
          <BigValue value={s.nmcli_active.length} unit="iface" color="violet" />
          <div className="mt-2 truncate text-txt-dim">
            {s.nmcli_active.map((a) => a.device).join(" · ") || "no active links"}
          </div>
        </Tile>

        {/* Subsystems with their own dedicated module tabs (/gps, /mesh, /sdr) are
            condensed here into one at-a-glance health strip instead of three full
            cards echoing those tabs. Each row drills through to its tab. */}
        <Tile title="PERIPHERALS" led={periphLed} padded={false}>
          <ul className="divide-y divide-line-dim">
            <li>
              <Link to="/gps" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-bg-strip/60">
                <span className="flex items-center gap-2">
                  <StatusLED color={gpsLed} size={6} label="GPS status" />
                  <span className="text-txt-body">GPS</span>
                </span>
                <span className="truncate text-txt-dim">
                  {gpsFix
                    ? <span className="text-cyan-signal tabular-nums">{s.gps.mode}D · {s.gps.lat?.toFixed(3)}, {s.gps.lon?.toFixed(3)}</span>
                    : s.gps.reason ?? "no fix"}
                </span>
              </Link>
            </li>
            <li>
              <Link to="/mesh" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-bg-strip/60">
                <span className="flex items-center gap-2">
                  <StatusLED color={meshLed} size={6} label="Mesh status" />
                  <span className="text-txt-body">MESH</span>
                </span>
                <span className="truncate text-txt-dim">
                  {s.mesh_node_count == null
                    ? "meshtasticd unreachable"
                    : <><span className="text-violet-bright tabular-nums">{s.mesh_node_count}</span> nodes</>}
                </span>
              </Link>
            </li>
            <li>
              <Link to="/sdr" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-bg-strip/60">
                <span className="flex items-center gap-2">
                  <StatusLED color={sdrLed} size={6} label="SDR status" />
                  <span className="text-txt-body">SDR</span>
                </span>
                <span className="truncate text-txt-dim">
                  {s.sdr.ok
                    ? <><span className="text-cyan-signal tabular-nums">{s.sdr.count ?? 0}</span> dev</>
                    : s.sdr.reason ?? "—"}
                </span>
              </Link>
            </li>
          </ul>
        </Tile>
      </div>
      <div className="col-span-12 mt-3"><AudioSettings /></div>
      </div>
  );
}
