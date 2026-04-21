import { useEffect, useRef, useState } from "react";
import { apiGet, type DashboardStatus } from "../lib/api";
import {
  BigValue,
  MiniSparkline,
  ModuleHeader,
  StatusLED,
  Tile,
  type LEDColor,
} from "../components/hud";

type Status = DashboardStatus | null;

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

        <Tile title="CORE TEMP" led={severityLed(tempSev)} headerRight={<MiniSparkline data={tempTrend} color="var(--amber-base)" />}>
          <BigValue
            value={s.temp_f != null ? `${s.temp_f.toFixed(1)}` : "—"}
            unit="°F"
            color={tempSev === "err" ? "pink" : tempSev === "warn" ? "amber" : "amber"}
            flashOnChange
          />
          <div className="mt-2 text-txt-dim">
            {s.temp_c != null ? `${s.temp_c.toFixed(1)} °C` : "sensor offline"}
            {s.throttled ? <span className="ml-2 text-pink-alert">{s.throttled}</span> : null}
          </div>
        </Tile>

        <Tile title="MEMORY" led={severityLed(memSev)} headerRight={<MiniSparkline data={memTrend} />}>
          <BigValue value={`${s.memory.percent.toFixed(0)}`} unit="%" color="amber" flashOnChange />
          <div className="mt-2 text-txt-dim">
            {s.memory.available_mb} MB free / {s.memory.total_mb} MB
          </div>
        </Tile>

        <Tile title="DISK /" led={severityLed(diskSev)}>
          <BigValue value={s.disk_root_mb_free} unit="MB free" color={diskSev === "err" ? "pink" : "amber"} flashOnChange />
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

        <Tile title="GPS" led={gpsLed}>
          <BigValue
            value={gpsFix ? `${s.gps.mode}D FIX` : "NO FIX"}
            color={gpsFix ? "mint" : "amber"}
            size="md"
          />
          <div className="mt-2 text-txt-dim">
            {gpsFix
              ? <><span className="text-cyan-signal tabular-nums">{s.gps.lat?.toFixed(5)}</span>, <span className="text-cyan-signal tabular-nums">{s.gps.lon?.toFixed(5)}</span></>
              : s.gps.reason ?? "awaiting sky view"}
          </div>
        </Tile>

        <Tile title="MESH NODES" led={meshLed}>
          <BigValue value={s.mesh_node_count ?? "—"} color="violet" flashOnChange />
          <div className="mt-2 text-txt-dim">
            {s.mesh_node_count == null ? "meshtasticd unreachable" : "Meshtastic TCP :4403"}
          </div>
        </Tile>

        <Tile title="SDR DEVICES" led={sdrLed}>
          <BigValue value={s.sdr.ok ? (s.sdr.count ?? 0) : "—"} unit="dev" color={s.sdr.ok ? "cyan" : "amber"} />
          <div className="mt-2 text-txt-dim">{s.sdr.reason ?? (s.sdr.ok ? "enumerated via SoapySDR" : "—")}</div>
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

        <Tile title="LINK INVENTORY" padded={false}>
          <ul className="divide-y divide-line-dim">
            {s.nmcli_active.length === 0 && (
              <li className="px-4 py-2 text-txt-dim">no active links</li>
            )}
            {s.nmcli_active.map((a) => (
              <li key={`${a.device}-${a.name}`} className="flex items-center justify-between gap-3 px-4 py-1.5">
                <span className="flex items-center gap-2">
                  <StatusLED color={a.state === "activated" ? "mint" : "amber"} size={6} label={`${a.device} state`} />
                  <span className="text-txt-body">{a.device}</span>
                </span>
                <span className="truncate text-txt-dim">{a.name}</span>
                <span className="hud-label text-violet-bright">{a.type}</span>
              </li>
            ))}
          </ul>
        </Tile>
      </div>
    </div>
  );
}
