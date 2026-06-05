import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";
import type { LEDColor } from "../components/hud";

// --------------------------------------------------------------------------- //
// Types — mirror the server_audit API (findings normalised to the 4-key schema)
// --------------------------------------------------------------------------- //
type Finding = { severity: string; title: string; detail: string; target: string };

type Summary = {
  critical: number; high: number; medium: number; low: number; info: number;
  total: number; max: string | null;
};

type Job = {
  id: string;
  audit_type: string;
  type: string;
  target: string;
  note: string;
  remote: boolean;
  status: string;
  findings: Finding[];
  summary: Summary;
  returncode: number | null;
  error: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type AuditType = { id: string; label: string; remote: boolean; tool: string; tool_present: boolean };

type Status = {
  ok: boolean;
  engaged: boolean;
  requires_engagement: boolean;
  audit_types: AuditType[];
  severities: string[];
  counts: Record<string, number>;
  jobs: Job[];
};

const SEV_LED: Record<string, LEDColor> = {
  critical: "pink", high: "pink", medium: "amber", low: "cyan", info: "dim",
};
const SEV_TEXT: Record<string, string> = {
  critical: "text-pink-alert", high: "text-pink-alert", medium: "text-amber-base",
  low: "text-cyan-signal", info: "text-txt-dim",
};
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const STATUS_LED: Record<string, LEDColor> = {
  queued: "amber", running: "cyan", success: "mint",
  failed: "pink", error: "pink", cancelled: "dim", unavailable: "amber",
};

export function Audit() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");

  // submit form
  const [auditType, setAuditType] = useState<string>("lynis");
  const [target, setTarget] = useState<string>("");
  const [user, setUser] = useState<string>("");
  const [port, setPort] = useState<string>("22");
  const [keyPath, setKeyPath] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiGet<Status>("/api/server_audit/status"));
    } catch { /**/ }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const d = await apiGet<{ jobs: Job[] }>("/api/server_audit/jobs");
      setJobs(d.jobs || []);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    loadJobs();
    const id = setInterval(() => { refresh(); loadJobs(); }, 2500);
    return () => clearInterval(id);
  }, [refresh, loadJobs]);

  const engaged = !!status?.engaged;
  const counts = status?.counts ?? {};
  const active = (counts.running ?? 0) + (counts.queued ?? 0);
  const types = status?.audit_types ?? [];
  const current = types.find((t) => t.id === auditType);
  const isRemote = current?.remote ?? auditType !== "lynis";
  const isSsh = auditType === "ssh-config";
  const stateLabel = status == null ? "ACQUIRING" : active > 0 ? "AUDITING" : "IDLE";

  // Findings to display: the selected job, else the newest job with findings.
  const shown = selected
    ? jobs.find((j) => j.id === selected)
    : jobs.find((j) => j.findings && j.findings.length > 0) ?? jobs[0];

  const run = async () => {
    if (auditType !== "lynis" && !target.trim()) { setNote("target is required for this audit type"); return; }
    if (isSsh && !user.trim()) { setNote("SSH user is required for ssh-config"); return; }
    const body: Record<string, unknown> = { type: auditType };
    if (auditType !== "lynis") body.target = target.trim();
    if (isSsh) {
      body.user = user.trim();
      body.port = Number(port) || 22;
      if (keyPath.trim()) body.key = keyPath.trim();
    }
    try {
      const d = await apiPost<{ job_id: string }>("/api/server_audit/run", body);
      setNote(`started ${auditType} audit — job ${d.job_id.slice(0, 8)}`);
      setSelected(d.job_id);
      loadJobs();
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? "refused (403) — remote audits require engagement ON and the target in scope. Start an engagement first."
          : `run failed: ${msg}`,
      );
    }
  };

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="13 SRV-AUD"
        title="Server Audit"
        state={stateLabel}
        icon="⛨"
        right={
          <span className="hud-label text-txt-dim">
            {types.length} audit types · {active} active · {counts.total ?? 0} total
          </span>
        }
      />

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      {status && isRemote && !engaged && (
        <div className="hud-tile border-pink-alert px-3 py-2 text-pink-alert flex items-center gap-2">
          <StatusLED color="pink" />
          <span>
            ENGAGEMENT OFF — <code className="text-pink-alert">{auditType}</code> is a remote audit and is
            engagement-gated. Running it will be refused with 403 until an engagement is active and the target
            is in scope. The local <code className="text-mint-safe">lynis</code> audit is ungated.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="QUEUE" led={active > 0 ? "cyan" : "amber"}>
          <BigValue value={active > 0 ? "BUSY" : "IDLE"} color={active > 0 ? "cyan" : "amber"} size="md" />
          <div className="mt-2 text-txt-dim tabular-nums">
            {counts.running ?? 0} run · {counts.queued ?? 0} queued
          </div>
        </Tile>
        <Tile title="SUCCESS" led={(counts.success ?? 0) > 0 ? "mint" : "dim"}>
          <BigValue value={counts.success ?? 0} color="mint" size="md" />
        </Tile>
        <Tile title="FINDINGS" led={shown && shown.summary?.total ? SEV_LED[shown.summary.max ?? "info"] : "dim"}>
          <BigValue value={shown?.summary?.total ?? 0} color="violet" size="md" />
          <span className="hud-label text-txt-dim">worst {shown?.summary?.max ?? "—"}</span>
        </Tile>
        <Tile title="ENGAGEMENT" led={engaged ? "mint" : "amber"}>
          <BigValue value={engaged ? "ON" : "OFF"} color={engaged ? "mint" : "amber"} size="md" />
        </Tile>
      </div>

      <Tile title="RUN AUDIT" led={engaged || !isRemote ? "mint" : "violet"}>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="hud-label block mb-1">Audit type</label>
              <select
                className="hud-btn w-full bg-bg-strip"
                value={auditType}
                onChange={(e) => setAuditType(e.target.value)}
              >
                {(types.length ? types : [
                  { id: "nmap-vuln", label: "nmap vuln scan", remote: true, tool: "nmap", tool_present: true },
                  { id: "nikto", label: "nikto web scan", remote: true, tool: "nikto", tool_present: true },
                  { id: "lynis", label: "lynis host hardening", remote: false, tool: "lynis", tool_present: true },
                  { id: "ssh-config", label: "ssh remote config audit", remote: true, tool: "ssh", tool_present: true },
                ]).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} — {t.label} {t.remote ? "[remote]" : "[local]"} {t.tool_present ? "" : "(tool missing)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="hud-label block mb-1">
                {auditType === "lynis" ? "Target (local host — none)" : isSsh ? "Host (IP / hostname)" : auditType === "nikto" ? "Target URL" : "Target (IP / host / CIDR)"}
              </label>
              <input
                className="hud-btn w-full bg-bg-strip tabular-nums disabled:opacity-40"
                value={auditType === "lynis" ? "localhost" : target}
                placeholder={auditType === "nikto" ? "http://10.10.0.5/" : "10.10.0.5"}
                disabled={auditType === "lynis"}
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
            {isSsh && (
              <>
                <div>
                  <label className="hud-label block mb-1">SSH user</label>
                  <input className="hud-btn w-full bg-bg-strip" value={user}
                    placeholder="root" onChange={(e) => setUser(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="hud-label block mb-1">Port</label>
                    <input className="hud-btn w-full bg-bg-strip tabular-nums" value={port}
                      onChange={(e) => setPort(e.target.value)} />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Key path (optional)</label>
                    <input className="hud-btn w-full bg-bg-strip" value={keyPath}
                      placeholder="~/.ssh/id_ed25519" onChange={(e) => setKeyPath(e.target.value)} />
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
            onClick={run}
            disabled={isRemote && !engaged}
          >
            ▶ RUN {auditType.toUpperCase()}
          </button>
          <div className="text-txt-dim text-[0.75rem]">
            Findings are normalised to <code className="text-violet-bright">{"{severity, title, detail, target}"}</code>{" "}
            and feed the engagement report. Remote audits (nmap / nikto / ssh) are engagement-gated; the local
            lynis hardening audit is not.
          </div>
        </div>
      </Tile>

      <FindingsPanel job={shown} />
      <JobsTable jobs={jobs} selected={selected} onSelect={setSelected} />
    </div>
  );
}

function SevBadge({ sev }: { sev: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusLED color={SEV_LED[sev] ?? "dim"} />
      <span className={`uppercase ${SEV_TEXT[sev] ?? "text-txt-body"}`}>{sev}</span>
    </span>
  );
}

function FindingsPanel({ job }: { job: Job | undefined }) {
  const findings = job?.findings ?? [];
  const s = job?.summary;
  return (
    <Tile
      title={job ? `FINDINGS — ${job.audit_type} · ${job.target}` : "FINDINGS"}
      padded={false}
      led={findings.length ? SEV_LED[s?.max ?? "info"] : "dim"}
      headerRight={
        s ? (
          <span className="hud-label text-txt-dim tabular-nums">
            {SEV_ORDER.map((k) => (s[k as keyof Summary] as number) ? `${(s[k as keyof Summary] as number)} ${k[0].toUpperCase()}` : null)
              .filter(Boolean).join(" · ") || "clean"}
          </span>
        ) : undefined
      }
    >
      {job?.error && (
        <div className="px-4 py-2 text-pink-alert text-[0.8125rem] border-b border-line-dim">{job.error}</div>
      )}
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left w-28">Severity</th>
              <th className="hud-label px-3 py-2 text-left">Title</th>
              <th className="hud-label px-3 py-2 text-left">Detail</th>
              <th className="hud-label px-3 py-2 text-left">Target</th>
            </tr>
          </thead>
          <tbody>
            {findings.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-txt-dim">
                {job ? "no findings — clean (or audit still running)" : "run an audit to see findings"}
              </td></tr>
            )}
            {findings.map((f, i) => (
              <tr key={i} className="border-b border-line-dim/40 align-top">
                <td className="px-3 py-1.5"><SevBadge sev={f.severity} /></td>
                <td className={`px-3 py-1.5 ${SEV_TEXT[f.severity] ?? "text-txt-body"}`}>{f.title}</td>
                <td className="px-3 py-1.5 text-txt-body break-words max-w-xl">{f.detail}</td>
                <td className="px-3 py-1.5 tabular-nums text-violet-bright">{f.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function JobsTable({ jobs, selected, onSelect }: {
  jobs: Job[]; selected: string | null; onSelect: (id: string) => void;
}) {
  return (
    <Tile title="AUDIT JOBS" padded={false} led={jobs.some((j) => j.status === "running") ? "cyan" : "violet"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">Type</th>
              <th className="hud-label px-3 py-2 text-left">Target</th>
              <th className="hud-label px-3 py-2 text-left">Status</th>
              <th className="hud-label px-3 py-2 text-left">Findings</th>
              <th className="hud-label px-3 py-2 text-left">When</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-txt-dim">no audit jobs yet — run one above</td></tr>
            )}
            {jobs.map((j) => (
              <tr
                key={j.id}
                className={`border-b border-line-dim/40 cursor-pointer hover:bg-bg-strip/60 ${selected === j.id ? "bg-bg-strip/80" : ""}`}
                onClick={() => onSelect(j.id)}
              >
                <td className="px-3 py-1 text-amber-base">{j.audit_type}</td>
                <td className="px-3 py-1 text-violet-bright tabular-nums" title={j.target}>{j.target}</td>
                <td className="px-3 py-1">
                  <span className="inline-flex items-center gap-2">
                    <StatusLED color={STATUS_LED[j.status] ?? "dim"} />
                    <span>{j.status}</span>
                  </span>
                </td>
                <td className="px-3 py-1 tabular-nums">
                  {j.summary?.total
                    ? <span className={SEV_TEXT[j.summary.max ?? "info"]}>{j.summary.total} ({j.summary.max})</span>
                    : <span className="text-txt-dim">—</span>}
                </td>
                <td className="px-3 py-1 tabular-nums text-txt-dim">{(j.submitted_at || "").slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}
