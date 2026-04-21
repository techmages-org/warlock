import { useEffect, useState } from "react";
import { apiGet, type DashboardStatus } from "../lib/api";
import { Tile } from "../components/Tile";

type Status = DashboardStatus | null;

export function Dashboard() {
  const [s, setStatus] = useState<Status>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await apiGet<DashboardStatus>("/api/dashboard/status");
        if (alive) {
          setStatus(r);
          setErr(null);
        }
      } catch (e: any) {
        if (alive) setErr(String(e));
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (err) return <div className="wl-card text-warlock-danger">dashboard error: {err}</div>;
  if (!s) return <div className="wl-card">loading…</div>;

  return (
    <div>
      <h1 className="text-lg font-bold mb-4">
        Dashboard <span className="text-warlock-muted">· {s.hostname}</span>
      </h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          title="CPU"
          value={`${s.cpu.percent}%`}
          subtitle={`load ${s.cpu.load_1m} / ${s.cpu.load_5m} / ${s.cpu.load_15m}`}
        />
        <Tile
          title="Temp"
          value={s.temp_f != null ? (s.temp_c != null ? `${s.temp_f}°F (${s.temp_c}°C)` : `${s.temp_f}°F`) : "n/a"}
          subtitle={s.throttled || undefined}
          severity={s.temp_f == null ? "warn" : s.temp_f > 176 ? "err" : s.temp_f > 158 ? "warn" : "ok"}
        />
        <Tile
          title="Memory"
          value={`${s.memory.percent}%`}
          subtitle={`${s.memory.available_mb} MB free / ${s.memory.total_mb} MB`}
        />
        <Tile
          title="Disk /"
          value={`${s.disk_root_mb_free} MB free`}
          subtitle={`${s.disk_root_percent}% used`}
          severity={s.disk_root_percent > 90 ? "err" : s.disk_root_percent > 80 ? "warn" : "ok"}
        />

        <Tile
          title="NTP (chrony)"
          value={s.chrony.ok ? `stratum ${s.chrony.stratum ?? "?"}` : "offline"}
          subtitle={
            s.chrony.ok
              ? `offset ${s.chrony.offset_s ?? "?"}s · ${s.chrony.source ?? ""}`
              : s.chrony.reason
          }
          severity={s.chrony.ok ? "ok" : "warn"}
        />
        <Tile
          title="GPS"
          value={s.gps.ok && (s.gps.mode ?? 0) >= 2 ? `fix ${s.gps.mode}D` : "no fix"}
          subtitle={
            s.gps.ok && (s.gps.mode ?? 0) >= 2
              ? `lat ${s.gps.lat} lon ${s.gps.lon}`
              : s.gps.reason
          }
          severity={s.gps.ok && (s.gps.mode ?? 0) >= 2 ? "ok" : "warn"}
        />
        <Tile
          title="Mesh nodes"
          value={s.mesh_node_count ?? "—"}
          subtitle={s.mesh_node_count == null ? "meshtasticd unreachable" : "Meshtastic over TCP 4403"}
          severity={s.mesh_node_count == null ? "warn" : "ok"}
        />
        <Tile
          title="SDR"
          value={s.sdr.ok ? `${s.sdr.count} dev` : "n/a"}
          subtitle={s.sdr.reason}
          severity={s.sdr.ok ? "ok" : "warn"}
        />

        <Tile
          title="Engagement"
          value={s.engagement.mode === "on" ? "ENGAGED" : "SAFE"}
          subtitle={s.engagement.name || ""}
          severity={s.engagement.mode === "on" ? "err" : "ok"}
        />
        <Tile
          title="RTC drift"
          value={s.rtc_drift_s != null ? `${s.rtc_drift_s}s` : "n/a"}
          subtitle="hwclock − system"
        />
        <Tile
          title="Net"
          value={`${s.nmcli_active.length} active`}
          subtitle={s.nmcli_active.map((a) => a.device).join(" ")}
        />
      </div>
    </div>
  );
}
