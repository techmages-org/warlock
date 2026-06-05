import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";

type OpsStatus = {
  ok: boolean;
  mode: "on" | "off" | string;
  engagement_id: string | null;
  name: string;
  scope: { ssids: string[]; bssids: string[]; ip_ranges: string[] };
  started_at: string | null;
  elapsed_s: number | null;
  auth_statement: string;
};

type EngagementRow = {
  id: string;
  name: string;
  status: string;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  targets_count: number;
  scope?: Record<string, unknown>;
};

type AuditRow = {
  id: string;
  ts: string;
  engagement_id: string | null;
  kind: string;
  command: string;
  target: string;
  note: string;
  outcome: string;
};

type ReportData = {
  ok: boolean;
  engagement_id: string;
  filename: string;
  generated_at: string;
  sections: string[];
  stats: {
    audit_total: number;
    ops_submitted: number;
    ops_by_type: Record<string, number>;
    scope_violations: number;
    targets_engaged: number;
    scans_run: number;
    hosts_discovered: number;
    captures_recorded: number;
    evidence_artifacts: number;
    duration: string;
  };
  markdown: string;
  html: string;
};

type Tab = "active" | "new" | "history" | "audit" | "report";

const TABS: { id: Tab; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "new", label: "New" },
  { id: "history", label: "History" },
  { id: "audit", label: "Audit" },
  { id: "report", label: "Report" },
];

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fmtElapsed(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function Ops() {
  const [tab, setTab] = useState<Tab>("active");
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [history, setHistory] = useState<EngagementRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [note, setNote] = useState<string>("");
  const [report, setReport] = useState<ReportData | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const loadReport = useCallback(async (engagementId: string) => {
    setReportBusy(true);
    setTab("report");
    setNote("");
    try {
      const d = await apiGet<ReportData>(
        `/api/ops/engagements/${engagementId}/report`,
      );
      setReport(d);
    } catch (e) {
      setReport(null);
      setNote(`report failed: ${e}`);
    } finally {
      setReportBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const st = await apiGet<OpsStatus>("/api/ops/status");
      setStatus(st);
    } catch {
      /* swallow */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (tab !== "history") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ engagements: EngagementRow[] }>("/api/ops/engagements?limit=50");
        if (alive) setHistory(d.engagements || []);
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
        if (alive) setAudit(d.audit || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  const engaged = status?.mode === "on";
  const stateLabel = status == null ? "LOADING" : engaged ? "ENGAGED" : "SAFE";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="10 OPS-CTL"
        title="Operations"
        state={stateLabel}
        icon="◆"
        right={
          <span className="hud-label text-txt-dim">
            {status?.engagement_id ? status.engagement_id.slice(0, 8) : "—"}
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

      {note && (
        <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>
      )}

      {tab === "active" && (
        <ActiveTab
          status={status}
          onReport={(id) => loadReport(id)}
          onEnd={async () => {
            try {
              await apiPost("/api/ops/engagements/end");
              setNote("engagement ended");
            } catch (e) { setNote(`end failed: ${e}`); }
            refresh();
          }}
          onKill={async () => {
            try {
              const d = await apiPost<Record<string, unknown>>("/api/ops/killswitch");
              setNote(`KILL fired — cancelled=${d?.cancelled_jobs ?? "?"}`);
            } catch (e) { setNote(`kill failed: ${e}`); }
            refresh();
          }}
        />
      )}

      {tab === "new" && (
        <NewTab
          onActivate={async (body) => {
            try {
              await apiPost("/api/ops/engagements", body);
              setNote("engagement activated — see Active tab");
              setTab("active");
            } catch (e) { setNote(`activate failed: ${e}`); }
            refresh();
          }}
        />
      )}

      {tab === "history" && (
        <HistoryTab rows={history} onReport={(id) => loadReport(id)} />
      )}
      {tab === "audit" && <AuditTab rows={audit} />}
      {tab === "report" && <ReportTab report={report} busy={reportBusy} />}
    </div>
  );
}

function ActiveTab({
  status,
  onEnd,
  onKill,
  onReport,
}: {
  status: OpsStatus | null;
  onEnd: () => void;
  onKill: () => void;
  onReport: (engagementId: string) => void;
}) {
  const engaged = status?.mode === "on";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="MODE" led={engaged ? "pink" : "mint"}>
          <BigValue
            value={engaged ? "ENGAGED" : "SAFE"}
            color={engaged ? "pink" : "mint"}
            size="md"
          />
        </Tile>
        <Tile title="ENGAGEMENT">
          <BigValue value={status?.name || "—"} color="violet" size="md" />
          <div className="mt-2 text-txt-dim break-all">
            {status?.engagement_id ?? ""}
          </div>
        </Tile>
        <Tile title="ELAPSED">
          <BigValue value={fmtElapsed(status?.elapsed_s ?? null)} color="amber" />
        </Tile>
        <Tile title="SCOPE">
          <div className="text-txt-body">
            <span className="text-violet-bright">{status?.scope?.ssids?.length ?? 0}</span>{" "}
            SSID
            <span className="mx-1 text-txt-dim">·</span>
            <span className="text-violet-bright">{status?.scope?.bssids?.length ?? 0}</span>{" "}
            BSSID
            <span className="mx-1 text-txt-dim">·</span>
            <span className="text-violet-bright">
              {status?.scope?.ip_ranges?.length ?? 0}
            </span>{" "}
            IP/CIDR
          </div>
          {engaged && (
            <div className="mt-2 space-y-0.5 text-txt-dim max-h-24 overflow-auto text-[0.75rem]">
              {[...(status?.scope.ssids || []).map((x) => `ssid: ${x}`),
                ...(status?.scope.bssids || []).map((x) => `bssid: ${x}`),
                ...(status?.scope.ip_ranges || []).map((x) => `ip: ${x}`)].slice(0, 20).map(
                (l, i) => <div key={i}>{l}</div>
              )}
            </div>
          )}
        </Tile>
      </div>

      {engaged && status?.auth_statement && (
        <Tile title="AUTHORIZATION STATEMENT" led="cyan">
          <pre className="whitespace-pre-wrap text-txt-body text-[0.8125rem]">
            {status.auth_statement}
          </pre>
        </Tile>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          className="hud-btn"
          onClick={onEnd}
          disabled={!engaged}
        >
          ■ END ENGAGEMENT
        </button>
        <button
          className="hud-btn border-pink-alert text-pink-alert"
          onClick={onKill}
        >
          ⚠ KILL SWITCH
        </button>
        <button
          className="hud-btn border-cyan-signal text-cyan-signal"
          onClick={() => status?.engagement_id && onReport(status.engagement_id)}
          disabled={!status?.engagement_id}
          title={status?.engagement_id ? "Build a client-ready report" : "No engagement to report on"}
        >
          📄 GENERATE REPORT
        </button>
        <span className="ml-2 flex items-center gap-2 text-txt-dim">
          <StatusLED color={engaged ? "pink" : "mint"} />
          {engaged ? "live engagement — all gated jobs active" : "no active engagement"}
        </span>
      </div>
    </div>
  );
}

function NewTab({
  onActivate,
}: {
  onActivate: (body: { name: string; authorization: string; targets: string[]; duration_hours: number }) => void;
}) {
  const [name, setName] = useState("");
  const [auth, setAuth] = useState("");
  const [targets, setTargets] = useState("");
  const [dur, setDur] = useState("4");

  return (
    <Tile title="NEW ENGAGEMENT" led="violet">
      <div className="space-y-3">
        <div>
          <label className="hud-label block mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q2 internal pentest"
            className="w-full border border-line-mid bg-bg-tile px-2 py-1 text-txt-hi focus:border-amber-base outline-none"
          />
        </div>
        <div>
          <label className="hud-label block mb-1">Authorization statement</label>
          <textarea
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
            rows={4}
            placeholder="Paste scope letter or lab-env note"
            className="w-full border border-line-mid bg-bg-tile px-2 py-1 text-txt-body focus:border-amber-base outline-none"
          />
        </div>
        <div>
          <label className="hud-label block mb-1">
            Targets — one per line (SSID, BSSID, or IP / CIDR)
          </label>
          <textarea
            value={targets}
            onChange={(e) => setTargets(e.target.value)}
            rows={6}
            placeholder="GuestWiFi&#10;aa:bb:cc:dd:ee:ff&#10;10.0.0.0/24"
            className="w-full border border-line-mid bg-bg-tile px-2 py-1 text-txt-body focus:border-amber-base outline-none font-mono"
          />
        </div>
        <div>
          <label className="hud-label block mb-1">Duration (hours)</label>
          <input
            value={dur}
            onChange={(e) => setDur(e.target.value)}
            className="w-32 border border-line-mid bg-bg-tile px-2 py-1 text-txt-hi focus:border-amber-base outline-none"
          />
        </div>
        <button
          type="button"
          className="hud-btn border-amber-base text-amber-base"
          onClick={() =>
            onActivate({
              name: name.trim(),
              authorization: auth.trim(),
              targets: targets.split("\n").map((t) => t.trim()).filter(Boolean),
              duration_hours: Number(dur) || 4,
            })
          }
        >
          ▶ ACTIVATE ENGAGEMENT
        </button>
      </div>
    </Tile>
  );
}

function HistoryTab({
  rows,
  onReport,
}: {
  rows: EngagementRow[];
  onReport: (engagementId: string) => void;
}) {
  return (
    <Tile title="ENGAGEMENT HISTORY" padded={false} led={rows.length > 0 ? "cyan" : "amber"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">Name</th>
              <th className="hud-label px-3 py-2 text-left">Status</th>
              <th className="hud-label px-3 py-2 text-left">Started</th>
              <th className="hud-label px-3 py-2 text-left">Ended</th>
              <th className="hud-label px-3 py-2 text-left">Targets</th>
              <th className="hud-label px-3 py-2 text-left">Report</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-txt-dim">no engagements yet</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line-dim/40">
                <td className="px-3 py-1 text-txt-body">{r.name}</td>
                <td className="px-3 py-1">
                  <span className={r.status === "active" ? "text-amber-base" : "text-txt-dim"}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-1 text-txt-dim tabular-nums">{(r.started_at ?? "—").slice(0, 19)}</td>
                <td className="px-3 py-1 text-txt-dim tabular-nums">{(r.ended_at ?? "—").slice(0, 19)}</td>
                <td className="px-3 py-1 text-violet-bright tabular-nums">{r.targets_count}</td>
                <td className="px-3 py-1">
                  <button
                    className="hud-btn border-cyan-signal text-cyan-signal px-2 py-0.5 text-[0.75rem]"
                    onClick={() => onReport(r.id)}
                    title="Generate a client-ready report for this engagement"
                  >
                    📄 Report
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function AuditTab({ rows }: { rows: AuditRow[] }) {
  return (
    <Tile title="AUDIT LOG — LAST 200" padded={false} led="cyan">
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full text-[0.75rem]">
          <thead className="sticky top-0 bg-bg-tile">
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">Time</th>
              <th className="hud-label px-3 py-2 text-left">Kind</th>
              <th className="hud-label px-3 py-2 text-left">Target</th>
              <th className="hud-label px-3 py-2 text-left">Outcome</th>
              <th className="hud-label px-3 py-2 text-left">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-txt-dim">audit log empty</td>
              </tr>
            )}
            {rows.map((a) => {
              const bad = a.outcome === "refused" || a.kind.includes("violation");
              return (
                <tr key={a.id} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 tabular-nums text-txt-dim">{(a.ts || "").slice(0, 19)}</td>
                  <td className={`px-3 py-1 ${bad ? "text-pink-alert" : "text-violet-bright"}`}>{a.kind}</td>
                  <td className="px-3 py-1 text-txt-body break-all">{a.target || "—"}</td>
                  <td className={`px-3 py-1 ${bad ? "text-pink-alert" : "text-mint-safe"}`}>{a.outcome}</td>
                  <td className="px-3 py-1 text-txt-dim break-all">{a.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function ReportStat({ label, value }: { label: string; value: string | number }) {
  return (
    <Tile title={label}>
      <BigValue value={String(value)} color="cyan" size="md" />
    </Tile>
  );
}

function ReportTab({ report, busy }: { report: ReportData | null; busy: boolean }) {
  const [view, setView] = useState<"preview" | "markdown">("preview");

  if (busy) {
    return (
      <Tile title="REPORT" led="cyan">
        <div className="text-txt-dim">building report…</div>
      </Tile>
    );
  }
  if (!report) {
    return (
      <Tile title="REPORT" led="amber">
        <div className="text-txt-body space-y-1">
          <div>No report loaded.</div>
          <div className="text-txt-dim text-[0.8125rem]">
            Use <span className="text-cyan-signal">📄 GENERATE REPORT</span> on the
            Active tab, or <span className="text-cyan-signal">📄 Report</span> on a row
            in History, to build a client-ready engagement report.
          </div>
        </div>
      </Tile>
    );
  }

  const s = report.stats;
  return (
    <div className="space-y-4">
      <Tile title="REPORT" led="cyan">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <BigValue value={report.filename} color="cyan" size="md" />
            <div className="mt-1 text-txt-dim text-[0.8125rem]">
              engagement <span className="break-all">{report.engagement_id}</span> ·
              generated {report.generated_at.replace("T", " ").slice(0, 19)} UTC
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="hud-btn border-amber-base text-amber-base"
              onClick={() =>
                downloadFile(`${report.filename}.md`, report.markdown, "text/markdown")
              }
            >
              ⬇ MARKDOWN
            </button>
            <button
              className="hud-btn border-violet-base text-violet-bright"
              onClick={() =>
                downloadFile(`${report.filename}.html`, report.html, "text/html")
              }
            >
              ⬇ HTML
            </button>
          </div>
        </div>
      </Tile>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <ReportStat label="OPS RUN" value={s.ops_submitted} />
        <ReportStat label="VIOLATIONS" value={s.scope_violations} />
        <ReportStat label="HOSTS FOUND" value={s.hosts_discovered} />
        <ReportStat label="CAPTURES" value={s.captures_recorded} />
        <ReportStat label="SCANS" value={s.scans_run} />
        <ReportStat label="TARGETS" value={s.targets_engaged} />
        <ReportStat label="ARTIFACTS" value={s.evidence_artifacts} />
        <ReportStat label="DURATION" value={s.duration} />
      </div>

      <div role="tablist" className="flex gap-1">
        <button
          role="tab"
          aria-selected={view === "preview"}
          className="hud-btn"
          data-active={view === "preview" ? "true" : undefined}
          onClick={() => setView("preview")}
        >
          Preview
        </button>
        <button
          role="tab"
          aria-selected={view === "markdown"}
          className="hud-btn"
          data-active={view === "markdown" ? "true" : undefined}
          onClick={() => setView("markdown")}
        >
          Markdown
        </button>
      </div>

      {view === "preview" ? (
        <Tile title="HTML PREVIEW" padded={false} led="cyan">
          <iframe
            title="report-preview"
            srcDoc={report.html}
            className="w-full h-[640px] border-0 bg-white"
          />
        </Tile>
      ) : (
        <Tile title="MARKDOWN SOURCE" padded={false} led="violet">
          <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap p-3 text-[0.8125rem] text-txt-body">
            {report.markdown}
          </pre>
        </Tile>
      )}
    </div>
  );
}
