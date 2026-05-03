import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";

type Status = {
  ok: boolean;
  hostname: string;
  uptime_s: number;
  cpu_percent: number;
  load_avg: number[];
  temp_c: number | null;
  throttled: string;
  gpu_temp: string;
  core_volt: string;
  memory: { total_mb: number; available_mb: number; percent: number };
  disk_root: { free_mb: number; total_mb: number; percent: number };
  audio_sink: string;
};

type Rail = {
  gpio: number;
  available: boolean;
  mode?: string;
  drive?: string;
  pull?: string;
  level?: string;
  service: string | null;
  label: string;
  raw?: string;
};
type AioStatus = { ok: boolean; rails: Record<string, Rail> };

type Service = {
  unit: string;
  active: boolean;
  enabled: boolean;
  activestate?: string;
  substate?: string;
  loadstate?: string;
  unitfilestate?: string;
  mainpid?: string;
};

type Iface = {
  name: string;
  type: string;
  up: boolean;
  ipv4: string[];
  ipv6: string[];
  mac: string;
  mtu?: number;
  speed?: number;
  ssid?: string;
  signal?: string;
};

type AP = { bssid: string; ssid: string; channel: string; signal: string; security: string; in_use: boolean };

type Tab = "hw" | "svc" | "net" | "log";
const TABS: { id: Tab; label: string }[] = [
  { id: "hw", label: "Hardware" },
  { id: "svc", label: "Services" },
  { id: "net", label: "Network" },
  { id: "log", label: "Logs" },
];

function fmtDur(sec: number): string {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function System() {
  const [tab, setTab] = useState<Tab>("hw");
  const [status, setStatus] = useState<Status | null>(null);
  const [aio, setAio] = useState<AioStatus | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [ifaces, setIfaces] = useState<Iface[]>([]);
  const [aps, setAps] = useState<AP[]>([]);
  const [logUnit, setLogUnit] = useState("warlock");
  const [logLines, setLogLines] = useState(200);
  const [logText, setLogText] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const refreshHw = useCallback(async () => {
    try {
      const s = await apiGet<Status>("/api/system/status");
      setStatus(s);
    } catch { /**/ }
    try {
      const a = await apiGet<AioStatus>("/api/system/aio");
      setAio(a);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refreshHw();
    const id = setInterval(refreshHw, 3000);
    return () => clearInterval(id);
  }, [refreshHw]);

  useEffect(() => {
    if (tab !== "svc") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ services: Service[] }>("/api/system/services");
        if (alive) setServices(d.services || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "net") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ interfaces: Iface[] }>("/api/system/network");
        if (alive) setIfaces(d.interfaces || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  const tailLog = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      qs.set("lines", String(logLines));
      if (logUnit) qs.set("unit", logUnit);
      const d = await apiGet<{ lines: string[] }>(`/api/system/journal?${qs.toString()}`);
      setLogText(d.lines || []);
    } catch (e) { setNote(`tail failed: ${e}`); }
  }, [logUnit, logLines]);

  const aioToggle = async (rail: string, action: "on" | "off") => {
    try {
      await apiPost(`/api/system/aio/${rail}/${action}`);
      setNote(`${rail} → ${action}`);
      refreshHw();
    } catch (e) { setNote(`${rail} ${action} failed: ${e}`); }
  };

  const svcAction = async (unit: string, action: string) => {
    try {
      await apiPost(`/api/system/services/${unit}/${action}`);
      setNote(`${unit}: ${action} ok`);
    } catch (e) { setNote(`${unit} ${action} failed: ${e}`); }
  };

  const wifiScan = async () => {
    setNote("rescanning WiFi APs…");
    try {
      const d = await apiPost<{ aps: AP[] }>("/api/system/wlan/scan");
      setAps(d.aps || []);
      setNote(`found ${d.aps?.length ?? 0} APs`);
    } catch (e) { setNote(`scan failed: ${e}`); }
  };

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="11 SYS-CTL"
        title="System"
        state={status ? "ONLINE" : "ACQUIRING"}
        icon="⚙"
        right={
          <span className="hud-label text-txt-dim">
            {status?.hostname ?? "—"} · {fmtDur(status?.uptime_s ?? 0)} · {status?.temp_c ?? "?"}°C
          </span>
        }
      />

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            onClick={() => setTab(t.id)} className="hud-btn"
            data-active={tab === t.id ? "true" : undefined}>
            {t.label}
          </button>
        ))}
      </div>

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="CPU TEMP" led={(status?.temp_c ?? 0) > 70 ? "amber" : "mint"}>
          <BigValue value={status?.temp_c != null ? `${status.temp_c}°` : "—"} color="amber" />
          <span className="hud-label text-txt-dim">{status?.throttled || "—"}</span>
        </Tile>
        <Tile title="MEMORY">
          <BigValue value={`${Math.round(status?.memory.percent ?? 0)}%`} color="violet" />
          <span className="hud-label text-txt-dim">{Math.round(status?.memory.available_mb ?? 0)} MB free</span>
        </Tile>
        <Tile title="DISK">
          <BigValue value={`${Math.round(status?.disk_root.free_mb ?? 0)}M`} color="cyan" />
          <span className="hud-label text-txt-dim">{status?.disk_root.percent ?? 0}% used</span>
        </Tile>
        <Tile title="UPTIME">
          <BigValue value={fmtDur(status?.uptime_s ?? 0)} color="mint" size="md" />
          <span className="hud-label text-txt-dim">{status?.audio_sink ?? ""}</span>
        </Tile>
      </div>

      {tab === "hw" && <HardwareTab aio={aio} onToggle={aioToggle} />}
      {tab === "svc" && <ServicesTab services={services} onAction={svcAction} />}
      {tab === "net" && <NetworkTab ifaces={ifaces} aps={aps} onScan={wifiScan} />}
      {tab === "log" && (
        <LogsTab unit={logUnit} setUnit={setLogUnit} lines={logLines} setLines={setLogLines}
          onTail={tailLog} text={logText} />
      )}
    </div>
  );
}

function HardwareTab({ aio, onToggle }: { aio: AioStatus | null; onToggle: (rail: string, action: "on" | "off") => void }) {
  const rails = aio ? Object.entries(aio.rails) : [];
  return (
    <Tile title="AIO V2 RAILS — GPIO control" led="amber">
      <div className="grid grid-cols-1 gap-3 p-2 md:grid-cols-3">
        {rails.length === 0 && <div className="text-txt-dim">no rail data — pinctrl unavailable?</div>}
        {rails.map(([rail, info]) => {
          const on = info.level === "hi";
          const ledColor: "mint" | "amber" | "pink" = on ? "amber" : "pink";
          const isToggleable = !!info.service;
          return (
            <div key={rail} className="hud-tile flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between">
                <div className="hud-label text-amber-base">{info.label}</div>
                <StatusLED color={ledColor} />
              </div>
              <BigValue value={(info.level ?? "?").toUpperCase()} color={on ? "amber" : "pink"} size="md" />
              <div className="hud-label text-txt-dim">GPIO{info.gpio} · {info.mode ?? "?"}</div>
              {isToggleable && (
                <div className="flex gap-2">
                  <button className="hud-btn border-amber-base text-amber-base" onClick={() => onToggle(rail, "on")}>ON</button>
                  <button className="hud-btn border-pink-alert text-pink-alert" onClick={() => onToggle(rail, "off")}>OFF</button>
                </div>
              )}
              {!isToggleable && <div className="hud-label text-txt-dim">read-only (spare)</div>}
            </div>
          );
        })}
      </div>
    </Tile>
  );
}

function ServicesTab({ services, onAction }: { services: Service[]; onAction: (unit: string, action: string) => void }) {
  return (
    <Tile title="SERVICES" padded={false} led="violet">
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">Unit</th>
              <th className="hud-label px-3 py-2 text-left">Active</th>
              <th className="hud-label px-3 py-2 text-left">Sub</th>
              <th className="hud-label px-3 py-2 text-left">Enabled</th>
              <th className="hud-label px-3 py-2 text-left">PID</th>
              <th className="hud-label px-3 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {services.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-txt-dim">loading…</td></tr>
            )}
            {services.map((s) => (
              <tr key={s.unit} className="border-b border-line-dim/40">
                <td className="px-3 py-1 text-violet-bright">{s.unit}</td>
                <td className="px-3 py-1">
                  <StatusLED color={s.active ? "mint" : "pink"} />
                  <span className="ml-2 text-txt-body">{s.activestate ?? (s.active ? "active" : "inactive")}</span>
                </td>
                <td className="px-3 py-1 text-txt-body">{s.substate ?? "—"}</td>
                <td className="px-3 py-1 text-amber-base">{s.enabled ? "✓" : "—"}</td>
                <td className="px-3 py-1 tabular-nums text-txt-dim">{s.mainpid !== "0" ? s.mainpid : "—"}</td>
                <td className="px-3 py-1">
                  <div className="flex gap-1">
                    <button className="hud-btn" onClick={() => onAction(s.unit, "start")}>start</button>
                    <button className="hud-btn border-pink-alert text-pink-alert" onClick={() => onAction(s.unit, "stop")}>stop</button>
                    <button className="hud-btn border-violet-base text-violet-bright" onClick={() => onAction(s.unit, "restart")}>restart</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function NetworkTab({ ifaces, aps, onScan }: { ifaces: Iface[]; aps: AP[]; onScan: () => void }) {
  return (
    <div className="space-y-3">
      <Tile title="INTERFACES" padded={false} led={ifaces.length > 0 ? "violet" : "amber"}>
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">Name</th>
                <th className="hud-label px-3 py-2 text-left">Type</th>
                <th className="hud-label px-3 py-2 text-left">Up</th>
                <th className="hud-label px-3 py-2 text-left">IPv4</th>
                <th className="hud-label px-3 py-2 text-left">MAC</th>
                <th className="hud-label px-3 py-2 text-left">SSID/extra</th>
              </tr>
            </thead>
            <tbody>
              {ifaces.map((i) => (
                <tr key={i.name} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 text-violet-bright">{i.name}</td>
                  <td className="px-3 py-1 text-amber-base">{i.type}</td>
                  <td className="px-3 py-1">
                    <StatusLED color={i.up ? "mint" : "pink"} />
                  </td>
                  <td className="px-3 py-1 tabular-nums text-cyan-signal">{i.ipv4.join(", ") || "—"}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-dim">{i.mac || "—"}</td>
                  <td className="px-3 py-1 text-txt-body">{i.ssid ? `${i.ssid} · ${i.signal ?? ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
      <div className="flex items-center gap-2">
        <button className="hud-btn border-violet-base text-violet-bright" onClick={onScan}>▶ Rescan WiFi APs</button>
        <span className="hud-label text-txt-dim">{aps.length} APs found</span>
      </div>
      {aps.length > 0 && (
        <Tile title="WIFI APs" padded={false} led="cyan">
          <div className="overflow-auto">
            <table className="w-full text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line-dim">
                  <th className="hud-label px-3 py-2 text-left">SSID</th>
                  <th className="hud-label px-3 py-2 text-left">BSSID</th>
                  <th className="hud-label px-3 py-2 text-left">CH</th>
                  <th className="hud-label px-3 py-2 text-left">SIG</th>
                  <th className="hud-label px-3 py-2 text-left">SEC</th>
                </tr>
              </thead>
              <tbody>
                {aps.map((a) => (
                  <tr key={`${a.bssid}-${a.ssid}`} className="border-b border-line-dim/40">
                    <td className="px-3 py-1 text-amber-base">{a.ssid || <span className="text-txt-dim">(hidden)</span>}{a.in_use && <span className="ml-2 text-mint-safe">★</span>}</td>
                    <td className="px-3 py-1 tabular-nums text-txt-body">{a.bssid}</td>
                    <td className="px-3 py-1 tabular-nums text-txt-dim">{a.channel}</td>
                    <td className="px-3 py-1 tabular-nums text-cyan-signal">{a.signal}</td>
                    <td className="px-3 py-1 text-violet-bright">{a.security || "OPEN"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tile>
      )}
    </div>
  );
}

function LogsTab(props: {
  unit: string; setUnit: (s: string) => void; lines: number; setLines: (n: number) => void;
  onTail: () => void; text: string[];
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="hud-tile px-3 py-1 text-txt-body"
          placeholder="unit (eg warlock, meshtasticd)"
          value={props.unit}
          onChange={(e) => props.setUnit(e.target.value)}
        />
        <input
          className="hud-tile w-24 px-3 py-1 tabular-nums text-txt-body"
          type="number"
          value={props.lines}
          onChange={(e) => props.setLines(parseInt(e.target.value || "200", 10))}
        />
        <button className="hud-btn border-violet-base text-violet-bright" onClick={props.onTail}>▶ Tail journal</button>
      </div>
      <Tile title={`JOURNAL — ${props.unit || "all"}`} padded={false} led="amber">
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap p-2 font-mono text-[0.75rem] text-txt-body">
          {props.text.length === 0 ? <span className="text-txt-dim">press tail to load</span> : props.text.join("\n")}
        </pre>
      </Tile>
    </div>
  );
}
