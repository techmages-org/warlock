// Server Audit — Ink TUI screen.
// Mirrors web/src/pages/Audit.tsx. Endpoints from src/warlock/modules/server_audit.py.
// MSP audit queue: nmap-vuln / nikto / lynis / ssh-config.
//
// Engagement gate: nmap-vuln, nikto, ssh-config are REMOTE and require active
// engagement. lynis audits the local deck only (no gate). The module has
// requires_engagement = True so the nav shows the ! gate indicator.
//
// Polls:
//   GET /api/server_audit/status  → engaged, audit_types, counts, jobs (latest 20)

import { Box, Text, useStdout } from "ink";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

const TILE_W = 28;

// ─── Types ─────────────────────────────────────────────────────────────────

type Finding = {
  severity: string;
  title: string;
  detail: string;
  target: string;
};

type JobSummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
  max: string | null;
};

type Job = {
  id: string;
  audit_type: string;
  target: string;
  note: string;
  remote: boolean;
  status: string;
  findings: Finding[];
  summary: JobSummary;
  returncode: number | null;
  error: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type AuditType = {
  id: string;
  label: string;
  remote: boolean;
  tool: string;
  tool_present: boolean;
};

type AuditStatus = {
  ok: boolean;
  engaged: boolean;
  requires_engagement: boolean;
  audit_types: AuditType[];
  severities: string[];
  counts: Record<string, number>;
  jobs: Job[];
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function findingLed(sev: string | null): LEDColor {
  if (!sev) return "dim";
  switch (sev) {
    case "critical":
    case "high":   return "pink";
    case "medium": return "amber";
    case "low":    return "cyan";
    default:       return "dim";
  }
}

function jobStatusLed(st: string): LEDColor {
  switch (st) {
    case "running":   return "cyan";
    case "success":   return "mint";
    case "failed":
    case "error":     return "pink";
    case "cancelled": return "dim";
    default:          return "amber"; // queued, unavailable
  }
}

// ─── Screen ────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();

  // Geometry: body budget after subtracting measured app-shell chrome.
  // chrome@120×24=8 rows, chrome@160×45=7 rows — use 8 as conservative constant.
  const termRows = (stdout.rows as number | undefined) ?? 24;
  const bodyBudget = Math.max(8, termRows - 8);

  const { data: status, error } = usePoll<AuditStatus>(
    () => api.get<AuditStatus>("/api/server_audit/status"),
    2500,
    [api],
  );

  if (error && !status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="13 SRV-AUD" title="Server Audit" state="LINK ERROR" icon="⛨" />
        <Tile title="ERROR" led="pink" width={TILE_W * 2}>
          <Text color={COLORS.pink}>server_audit error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  if (!status) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="13 SRV-AUD" title="Server Audit" state="ACQUIRING" icon="⛨" />
        <Tile title="BOOT" led="amber" width={TILE_W}>
          <Text color={TEXT.dim}>acquiring telemetry…</Text>
        </Tile>
      </Box>
    );
  }

  const counts = status.counts;
  const active = (counts.running ?? 0) + (counts.queued ?? 0);
  const engaged = status.engaged;
  const jobs = status.jobs ?? [];
  const stateLabel = active > 0 ? "AUDITING" : "IDLE";

  // Latest job that has findings (for the findings panel)
  const latestJob = jobs.find((j) => (j.findings?.length ?? 0) > 0) ?? jobs[0];
  const latestFindings = latestJob?.findings ?? [];
  const latestSummary = latestJob?.summary ?? null;

  // ── Dynamic list caps ─────────────────────────────────────────────────────
  // Fixed rows consumed by always-present elements:
  //   1 ModuleHeader + (0|1 engagement banner) + 5 status tiles + (0|5 tools row)
  // At small terminals (bodyBudget < 20) we hide the tools row to save 5 rows —
  // it's informational; the jobs table is more actionable.
  const showTools = bodyBudget >= 20;
  const engBannerRows = engaged ? 0 : 1;
  const FIXED_ROWS = 1 + engBannerRows + 5 + (showTools ? 5 : 0);
  const dynamicBudget = Math.max(2, bodyBudget - FIXED_ROWS);

  // Jobs tile overhead = top border(1) + title row(1) + col-label row(1) + bottom border(1) = 4
  // Findings tile overhead = top border(1) + title row(1) + bottom border(1) = 3
  const JOBS_OVERHEAD = 4;
  const FINDINGS_OVERHEAD = 3;
  const FINDINGS_MIN = 3; // minimum rows to bother showing the findings panel

  const hasFindingsData = latestJob != null && latestFindings.length > 0;
  // Can we fit findings? Need: jobs overhead + ≥1 job row + findings overhead + FINDINGS_MIN
  const canShowFindings = hasFindingsData &&
    dynamicBudget >= JOBS_OVERHEAD + 1 + FINDINGS_OVERHEAD + FINDINGS_MIN;

  // Jobs cap: if findings panel will show, reserve space for it
  const maxJobs = canShowFindings
    ? Math.max(1, dynamicBudget - JOBS_OVERHEAD - FINDINGS_OVERHEAD - FINDINGS_MIN)
    : Math.max(1, dynamicBudget - JOBS_OVERHEAD);

  // Actual rows the jobs table will consume (data rows only; +1 for indicator if capped)
  const jobsRowsUsed = jobs.length > maxJobs ? maxJobs : jobs.length;

  // Findings cap: whatever is left after jobs
  const findingsBudget = canShowFindings
    ? dynamicBudget - JOBS_OVERHEAD - jobsRowsUsed - FINDINGS_OVERHEAD
    : 0;
  const maxFindings = Math.max(0, findingsBudget);
  const showFindingsPanel = canShowFindings && maxFindings >= FINDINGS_MIN;

  // Slice with +N more indicator
  const hasMoreJobs = jobs.length > maxJobs;
  const displayJobs = hasMoreJobs ? jobs.slice(0, maxJobs - 1) : jobs.slice(0, maxJobs);
  const hiddenJobs = jobs.length - displayJobs.length;

  const hasMoreFindings = latestFindings.length > maxFindings;
  const displayFindings = hasMoreFindings
    ? latestFindings.slice(0, maxFindings - 1)
    : latestFindings.slice(0, maxFindings);
  const hiddenFindings = latestFindings.length - displayFindings.length;

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="13 SRV-AUD"
        title="Server Audit"
        state={stateLabel}
        icon="⛨"
        right={
          <Text color={TEXT.dim}>
            {status.audit_types.length} types · {active} active · {counts.total ?? 0} total
          </Text>
        }
      />

      {/* Engagement gate warning — remote audit types require engagement ON */}
      {!engaged && (
        <Box>
          <StatusLED color="pink" />
          <Text color={COLORS.pink}>
            {" ! ENGAGEMENT OFF — nmap-vuln / nikto / ssh-config require active engagement · lynis (local) always ok"}
          </Text>
        </Box>
      )}

      {/* ── Status tiles ─────────────────────────────────────────────────── */}
      <Box>
        <Tile title="QUEUE" led={active > 0 ? "cyan" : "amber"} width={TILE_W}>
          <BigValue value={active > 0 ? "BUSY" : "IDLE"} color={active > 0 ? "cyan" : "amber"} />
          <Text color={TEXT.dim}>
            {counts.running ?? 0} running · {counts.queued ?? 0} queued
          </Text>
        </Tile>

        <Tile
          title="SUCCESS"
          led={(counts.success ?? 0) > 0 ? "mint" : "dim"}
          width={TILE_W}
        >
          <BigValue value={counts.success ?? 0} color="mint" />
          <Text color={TEXT.dim}>
            {counts.failed ?? 0} failed · {counts.cancelled ?? 0} cancelled
          </Text>
        </Tile>

        <Tile
          title="FINDINGS"
          led={latestSummary?.total ? findingLed(latestSummary.max) : "dim"}
          width={TILE_W}
        >
          <BigValue value={latestSummary?.total ?? 0} color="violet" />
          <Text color={TEXT.dim}>worst {latestSummary?.max ?? "—"}</Text>
        </Tile>

        <Tile
          title="ENGAGEMENT"
          led={engaged ? "mint" : "amber"}
          width={TILE_W}
        >
          <BigValue value={engaged ? "ON" : "OFF"} color={engaged ? "mint" : "amber"} />
          <Text color={TEXT.dim}>
            {engaged ? "remote audits ok" : "! remote gated"}
          </Text>
        </Tile>
      </Box>

      {/* ── Audit tools availability (hidden at small terminals to save 5 rows) ── */}
      {showTools && (
        <Box>
          {status.audit_types.map((t) => (
            <Tile
              key={t.id}
              title={t.id.toUpperCase()}
              led={t.tool_present ? (t.remote && !engaged ? "amber" : "mint") : "dim"}
              width={TILE_W}
            >
              <Text color={t.tool_present ? TEXT.body : TEXT.dim}>
                {t.tool_present ? t.label : `${t.tool} not installed`}
              </Text>
              {t.remote ? (
                <Text color={COLORS.pink}>remote · engagement req.</Text>
              ) : (
                <Text color={COLORS.mint}>local · no gate</Text>
              )}
            </Tile>
          ))}
        </Box>
      )}

      {/* ── Jobs table ───────────────────────────────────────────────────── */}
      <Tile
        title="AUDIT JOBS"
        led={jobs.some((j) => j.status === "running") ? "cyan" : "violet"}
        width={TILE_W * 4}
      >
        {jobs.length === 0 ? (
          <Text color={TEXT.dim}>no audit jobs yet</Text>
        ) : (
          <Box flexDirection="column">
            <Box>
              <Text color={TEXT.dim}>
                {"Type         Target               Status     Findings   When"}
              </Text>
            </Box>
            {displayJobs.map((j) => {
              const findStr = j.summary?.total
                ? `${j.summary.total}(${j.summary.max ?? "—"})`
                : "—";
              return (
                <Box key={j.id}>
                  <Text color={COLORS.amber}>{j.audit_type.padEnd(13)}</Text>
                  <Text color={COLORS.violet}>
                    {j.target.slice(0, 20).padEnd(21)}
                  </Text>
                  <Box>
                    <StatusLED color={jobStatusLed(j.status)} />
                    <Text color={TEXT.body}>{` ${j.status}`.padEnd(11)}</Text>
                  </Box>
                  <Text color={COLORS[findingLed(j.summary?.max ?? null)]}>
                    {findStr.padEnd(11)}
                  </Text>
                  <Text color={TEXT.dim}>
                    {(j.submitted_at || "").slice(0, 19)}
                  </Text>
                </Box>
              );
            })}
            {hiddenJobs > 0 && (
              <Text color={TEXT.dim}>+{hiddenJobs} more jobs…</Text>
            )}
          </Box>
        )}
      </Tile>

      {/* ── Latest findings panel (hidden when terminal is too short) ─────── */}
      {showFindingsPanel && latestJob != null && (
        <Tile
          title={`FINDINGS — ${latestJob.audit_type} · ${latestJob.target}`}
          led={findingLed(latestSummary?.max ?? null)}
          width={TILE_W * 4}
        >
          <Box flexDirection="column">
            {latestJob.error ? (
              <Text color={COLORS.pink}>{latestJob.error}</Text>
            ) : null}
            {displayFindings.map((f, i) => (
              <Box key={i} width={TILE_W * 4 - 4}>
                <StatusLED color={findingLed(f.severity)} />
                <Text color={COLORS[findingLed(f.severity)]}>
                  {` ${f.severity.toUpperCase().padEnd(9)}`}
                </Text>
                <Text color={TEXT.body}>
                  {f.title.slice(0, 40).padEnd(41)}
                </Text>
                <Text color={TEXT.dim} wrap="truncate-end">
                  {f.detail}
                </Text>
              </Box>
            ))}
            {hiddenFindings > 0 && (
              <Text color={TEXT.dim}>+{hiddenFindings} more findings…</Text>
            )}
          </Box>
        </Tile>
      )}
    </Box>
  );
}
