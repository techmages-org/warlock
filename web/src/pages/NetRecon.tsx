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

type Tab = "hosts" | "scans" | "new" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "hosts", label: "Hosts" },
  { id: "scans", label: "Scans" },
  { id: "new", label: "New scan" },
  { id: "audit", label: "Audit" },
];

type AuditRow = { id: string; ts: string; kind: string; command: string; target: string; outcome: string };

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
