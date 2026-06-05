import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";

type Port = { port: number; proto: string; state: string; service: string; product?: string; version?: string };
type Host = {
  ip: string;
  mac: string;
  vendor: string;
  hostname: string;
  ports: Port[];
  os_guess: string;
  first_seen: string | null;
  last_seen: string | null;
};
type Scan = {
  id: string;
  target: string;
  profile: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  hosts_found: number;
  engagement_id: string | null;
};
type Status = {
  ok: boolean;
  subnet: string | null;
  gateway: string | null;
  hosts_seen: number;
  last_scan: { id: string; target: string; profile: string; status: string; hosts_found: number } | null;
  profiles: string[];
};

type Tab = "hosts" | "scans" | "new" | "defense" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "hosts", label: "Hosts" },
  { id: "scans", label: "Scans" },
  { id: "new", label: "New scan" },
  { id: "defense", label: "Defense" },
  { id: "audit", label: "Audit" },
];

type AuditRow = { id: string; ts: string; kind: string; command: string; target: string; outcome: string };

type BaselineMeta = {
  created_at: string | null;
  subnet: string | null;
  profile: string;
  host_discovery_only: boolean;
  host_count: number;
  service_count: number;
};
type DefenseAlert = {
  type: "new_host" | "gone_host" | "new_service" | "gone_service" | "mac_changed";
  severity: "info" | "warning" | "critical";
  ip: string;
  mac?: string;
  old_mac?: string;
  vendor?: string;
  hostname?: string;
  port?: number;
  proto?: string;
  service?: string;
  message: string;
};
type AlertSummary = {
  new_host: number; gone_host: number; new_service: number;
  gone_service: number; mac_changed: number; total: number;
};
type DiffResult = {
  generated_at: string | null;
  summary: AlertSummary;
  alerts: DefenseAlert[];
};

export function NetRecon() {
  const [tab, setTab] = useState<Tab>("hosts");
  const [status, setStatus] = useState<Status | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // form state
  const [targets, setTargets] = useState("");
  const [profile, setProfile] = useState("quick");

  // defense / monitoring state
  const [baseline, setBaseline] = useState<BaselineMeta | null>(null);
  const [defProfile, setDefProfile] = useState("quick");
  const [diff, setDiff] = useState<DiffResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiGet<Status>("/api/net_recon/status"));
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (tab !== "hosts") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ hosts: Host[] }>("/api/net_recon/hosts?limit=500");
        if (alive) setHosts(d.hosts || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "scans") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ scans: Scan[] }>("/api/net_recon/scans?limit=100");
        if (alive) setScans(d.scans || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "audit") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ audit: AuditRow[] }>("/api/ops/audit?limit=200");
        if (alive) setAudit((d.audit || []).filter(a => a.command.includes("nmap") || a.command.includes("arp")));
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "defense") return;
    let alive = true;
    const load = async () => {
      try {
        const b = await apiGet<{ baseline: BaselineMeta | null }>("/api/net_recon/baseline");
        if (alive) setBaseline(b.baseline);
      } catch { /**/ }
      try {
        const a = await apiGet<DiffResult>("/api/net_recon/alerts");
        if (alive) setDiff(a);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  const runArp = async () => {
    setBusy(true); setNote("ARP sweep running…");
    try {
      const d = await apiPost<{ summary: { up: number; total: number } }>("/api/net_recon/arpscan");
      setNote(`ARP sweep ok — ${d.summary?.up ?? 0}/${d.summary?.total ?? 0} hosts up`);
    } catch (e) { setNote(`ARP sweep failed: ${e}`); }
    finally { setBusy(false); refresh(); }
  };

  const runScan = async () => {
    const tlist = targets.split(/[\s,]+/).filter(Boolean);
    if (!tlist.length) { setNote("targets required"); return; }
    setBusy(true); setNote(`Port scan running (${profile})…`);
    try {
      const d = await apiPost<{ summary: { up: number } }>("/api/net_recon/portscan", { targets: tlist, profile });
      setNote(`scan ok — ${d.summary?.up ?? 0} up`);
    } catch (e) { setNote(`scan failed: ${e}`); }
    finally { setBusy(false); refresh(); }
  };

  const setBaselineNow = async () => {
    setBusy(true); setNote(`Capturing baseline (${defProfile})…`);
    try {
      const d = await apiPost<{ baseline: BaselineMeta }>("/api/net_recon/baseline", { profile: defProfile });
      setBaseline(d.baseline);
      setNote(`baseline saved — ${d.baseline?.host_count ?? 0} hosts, ${d.baseline?.service_count ?? 0} services`);
    } catch (e) { setNote(`baseline failed: ${e}`); }
    finally { setBusy(false); }
  };

  const runDiff = async () => {
    setBusy(true); setNote(`Diffing vs baseline (${defProfile})…`);
    try {
      const d = await apiPost<DiffResult>("/api/net_recon/diff", { profile: defProfile });
      setDiff(d);
      const s = d.summary;
      setNote(`diff done — ${s.total} alerts (${s.new_host} new host, ${s.new_service} new svc, ${s.mac_changed} mac, ${s.gone_host} gone)`);
    } catch (e) { setNote(`diff failed: ${e}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="07 NET-REC"
        title="Net Recon"
        state={busy ? "SCANNING" : "READY"}
        icon="⚘"
        right={
          <span className="hud-label text-txt-dim">
            {status?.subnet ?? "—"} · {status?.hosts_seen ?? 0} hosts · gw {status?.gateway ?? "—"}
          </span>
        }
      />

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="hud-btn"
            data-active={tab === t.id ? "true" : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="SUBNET" led="violet">
          <BigValue value={status?.subnet ?? "—"} color="violet" size="md" />
        </Tile>
        <Tile title="HOSTS">
          <BigValue value={String(status?.hosts_seen ?? 0)} color="cyan" />
        </Tile>
        <Tile title="GATEWAY">
          <BigValue value={status?.gateway ?? "—"} color="amber" size="md" />
        </Tile>
        <Tile title="LAST SCAN" led={status?.last_scan?.status === "success" ? "mint" : "amber"}>
          <BigValue value={status?.last_scan?.profile ?? "—"} color="mint" size="md" />
          <span className="hud-label text-txt-dim">
            {status?.last_scan?.status ?? "—"} · {status?.last_scan?.hosts_found ?? 0} up
          </span>
        </Tile>
      </div>

      {tab === "hosts" && <HostsTab hosts={hosts} />}
      {tab === "scans" && <ScansTab scans={scans} />}
      {tab === "new" && (
        <NewScanTab
          subnet={status?.subnet ?? ""}
          targets={targets}
          setTargets={setTargets}
          profile={profile}
          setProfile={setProfile}
          profiles={status?.profiles ?? ["quick", "top1000", "full", "service", "vuln"]}
          busy={busy}
          onArp={runArp}
          onScan={runScan}
        />
      )}
      {tab === "defense" && (
        <DefenseTab
          baseline={baseline}
          diff={diff}
          profile={defProfile}
          setProfile={setDefProfile}
          profiles={status?.profiles ?? ["quick", "top1000", "full", "service", "vuln"]}
          busy={busy}
          onSetBaseline={setBaselineNow}
          onDiff={runDiff}
        />
      )}
      {tab === "audit" && <AuditTab rows={audit} />}
    </div>
  );
}

function HostsTab({ hosts }: { hosts: Host[] }) {
  return (
    <Tile title="HOSTS" padded={false} led={hosts.length > 0 ? "mint" : "amber"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">IP</th>
              <th className="hud-label px-3 py-2 text-left">MAC</th>
              <th className="hud-label px-3 py-2 text-left">Vendor</th>
              <th className="hud-label px-3 py-2 text-left">Hostname</th>
              <th className="hud-label px-3 py-2 text-left">Open ports</th>
              <th className="hud-label px-3 py-2 text-left">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {hosts.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-txt-dim">no hosts yet — run an ARP sweep</td></tr>
            )}
            {hosts.map((h) => (
              <tr key={h.ip} className="border-b border-line-dim/40">
                <td className="px-3 py-1 tabular-nums text-violet-bright">{h.ip}</td>
                <td className="px-3 py-1 tabular-nums text-txt-body">{h.mac || <span className="text-txt-dim">—</span>}</td>
                <td className="px-3 py-1 text-txt-body">{h.vendor || <span className="text-txt-dim">—</span>}</td>
                <td className="px-3 py-1 text-amber-base">{h.hostname || <span className="text-txt-dim">—</span>}</td>
                <td className="px-3 py-1 text-cyan-signal tabular-nums">
                  {h.ports?.length ? h.ports.slice(0, 8).map(p => `${p.port}/${p.proto}`).join(" ") : <span className="text-txt-dim">—</span>}
                </td>
                <td className="px-3 py-1 tabular-nums text-txt-dim">{(h.last_seen || "").slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function ScansTab({ scans }: { scans: Scan[] }) {
  return (
    <Tile title="SCAN HISTORY" padded={false} led={scans.length > 0 ? "violet" : "amber"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">When</th>
              <th className="hud-label px-3 py-2 text-left">Target</th>
              <th className="hud-label px-3 py-2 text-left">Profile</th>
              <th className="hud-label px-3 py-2 text-left">Status</th>
              <th className="hud-label px-3 py-2 text-left">Hosts</th>
              <th className="hud-label px-3 py-2 text-left">Eng?</th>
            </tr>
          </thead>
          <tbody>
            {scans.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-txt-dim">no scans yet</td></tr>
            )}
            {scans.map((s) => (
              <tr key={s.id} className="border-b border-line-dim/40">
                <td className="px-3 py-1 tabular-nums text-txt-dim">{(s.started_at || "").slice(0, 19)}</td>
                <td className="px-3 py-1 text-violet-bright">{s.target}</td>
                <td className="px-3 py-1 text-amber-base">{s.profile}</td>
                <td className="px-3 py-1">
                  <StatusLED color={s.status === "success" ? "mint" : s.status === "running" ? "amber" : "pink"} />
                  <span className="ml-2">{s.status}</span>
                </td>
                <td className="px-3 py-1 tabular-nums text-cyan-signal">{s.hosts_found}</td>
                <td className="px-3 py-1 text-txt-dim">{s.engagement_id ? "✓" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function NewScanTab(props: {
  subnet: string; targets: string; setTargets: (v: string) => void;
  profile: string; setProfile: (v: string) => void; profiles: string[];
  busy: boolean; onArp: () => void; onScan: () => void;
}) {
  return (
    <Tile title="NEW SCAN" led="violet">
      <div className="space-y-3 p-2">
        <div className="grid gap-2">
          <label className="hud-label text-txt-dim">Targets — IP or CIDR (comma or whitespace separated)</label>
          <input
            className="hud-tile w-full px-3 py-2 text-txt-body"
            placeholder={props.subnet || "192.168.100.0/24, 192.168.100.1"}
            value={props.targets}
            onChange={(e) => props.setTargets(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <label className="hud-label text-txt-dim">Profile</label>
          <div className="flex flex-wrap gap-2">
            {props.profiles.map((p) => (
              <button
                key={p}
                className="hud-btn"
                data-active={props.profile === p ? "true" : undefined}
                onClick={() => props.setProfile(p)}
              >{p}</button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="hud-btn border-amber-base text-amber-base" disabled={props.busy} onClick={props.onArp}>
            ▶ ARP sweep ({props.subnet || "current LAN"})
          </button>
          <button className="hud-btn border-violet-base text-violet-bright" disabled={props.busy} onClick={props.onScan}>
            ▶ Run port scan
          </button>
        </div>
        <div className="hud-label text-txt-dim">
          Engagement gate: triggered for non-RFC1918 targets or CIDR &lt; /24. Single RFC1918 IP = no gate.
        </div>
      </div>
    </Tile>
  );
}

const SEV_LED: Record<DefenseAlert["severity"], "pink" | "amber" | "violet"> = {
  critical: "pink",
  warning: "amber",
  info: "violet",
};
const SEV_TEXT: Record<DefenseAlert["severity"], string> = {
  critical: "text-pink-alert",
  warning: "text-amber-base",
  info: "text-txt-dim",
};

function DefenseTab(props: {
  baseline: BaselineMeta | null;
  diff: DiffResult | null;
  profile: string;
  setProfile: (v: string) => void;
  profiles: string[];
  busy: boolean;
  onSetBaseline: () => void;
  onDiff: () => void;
}) {
  const { baseline, diff } = props;
  const summary = diff?.summary;
  const alerts = diff?.alerts ?? [];
  return (
    <div className="space-y-3">
      <Tile title="BLUE-TEAM MONITORING" led={baseline ? "mint" : "amber"}>
        <div className="space-y-3 p-2">
          <div className="hud-label text-txt-dim">
            Capture a known-good <span className="text-mint-safe">baseline</span> of your network, then{" "}
            <span className="text-violet-bright">diff</span> later scans to flag new devices &amp; new open services.
            Passive monitoring of your own subnet — no engagement gate. Use the same profile for baseline and diff so
            services compare apples-to-apples (a host-discovery sweep sees no ports).
          </div>
          <div className="grid gap-2">
            <label className="hud-label text-txt-dim">Scan profile</label>
            <div className="flex flex-wrap gap-2">
              {props.profiles.map((p) => (
                <button
                  key={p}
                  className="hud-btn"
                  data-active={props.profile === p ? "true" : undefined}
                  onClick={() => props.setProfile(p)}
                >{p}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="hud-btn border-mint-safe text-mint-safe" disabled={props.busy} onClick={props.onSetBaseline}>
              ◉ Set baseline ({props.profile})
            </button>
            <button
              className="hud-btn border-violet-base text-violet-bright"
              disabled={props.busy || !baseline}
              onClick={props.onDiff}
            >
              ▶ Run diff vs baseline
            </button>
          </div>
        </div>
      </Tile>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="BASELINE" led={baseline ? "mint" : "amber"}>
          <BigValue value={baseline ? String(baseline.host_count) : "—"} color={baseline ? "mint" : "amber"} />
          <span className="hud-label text-txt-dim">
            {baseline
              ? `${baseline.service_count} svc · ${baseline.profile} · ${(baseline.created_at || "").slice(0, 19)}`
              : "no baseline set"}
          </span>
        </Tile>
        <Tile title="NEW DEVICES" led={summary && summary.new_host > 0 ? "pink" : "violet"}>
          <BigValue value={String(summary?.new_host ?? 0)} color={summary && summary.new_host ? "pink" : "cyan"} />
        </Tile>
        <Tile title="NEW SERVICES" led={summary && summary.new_service > 0 ? "amber" : "violet"}>
          <BigValue value={String(summary?.new_service ?? 0)} color={summary && summary.new_service ? "amber" : "cyan"} />
        </Tile>
        <Tile title="MAC CHANGED" led={summary && summary.mac_changed > 0 ? "pink" : "violet"}>
          <BigValue value={String(summary?.mac_changed ?? 0)} color={summary && summary.mac_changed ? "pink" : "cyan"} />
          <span className="hud-label text-txt-dim">
            {diff?.generated_at ? `last diff ${(diff.generated_at || "").slice(0, 19)}` : "not run yet"}
          </span>
        </Tile>
      </div>

      <Tile title="ALERTS" padded={false} led={alerts.length ? "pink" : "mint"}>
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">Sev</th>
                <th className="hud-label px-3 py-2 text-left">Type</th>
                <th className="hud-label px-3 py-2 text-left">Host</th>
                <th className="hud-label px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-txt-dim">
                  {baseline ? "no alerts — network matches baseline (run a diff to refresh)" : "set a baseline, then run a diff"}
                </td></tr>
              )}
              {alerts.map((a, i) => (
                <tr key={`${a.type}-${a.ip}-${a.port ?? ""}-${i}`} className="border-b border-line-dim/40">
                  <td className="px-3 py-1">
                    <StatusLED color={SEV_LED[a.severity]} />
                    <span className={`ml-2 ${SEV_TEXT[a.severity]}`}>{a.severity}</span>
                  </td>
                  <td className="px-3 py-1 text-amber-base">{a.type}</td>
                  <td className="px-3 py-1 tabular-nums text-violet-bright">{a.ip}</td>
                  <td className="px-3 py-1 text-txt-body">{a.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
    </div>
  );
}

function AuditTab({ rows }: { rows: AuditRow[] }) {
  return (
    <Tile title="AUDIT — net recon commands" padded={false} led={rows.length ? "violet" : "amber"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">Time</th>
              <th className="hud-label px-3 py-2 text-left">Kind</th>
              <th className="hud-label px-3 py-2 text-left">Target</th>
              <th className="hud-label px-3 py-2 text-left">Command</th>
              <th className="hud-label px-3 py-2 text-left">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-txt-dim">no audit entries match</td></tr>
            )}
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-line-dim/40">
                <td className="px-3 py-1 tabular-nums text-txt-dim">{(a.ts || "").slice(0, 19)}</td>
                <td className="px-3 py-1 text-amber-base">{a.kind}</td>
                <td className="px-3 py-1 text-violet-bright">{a.target}</td>
                <td className="px-3 py-1 text-txt-body truncate max-w-md">{a.command}</td>
                <td className="px-3 py-1 text-cyan-signal">{a.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}
