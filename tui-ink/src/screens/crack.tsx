// ============================================================================
// CRACK QUEUE (crack) — managed hashcat crack queue. Mirrors web Crack.tsx
// against the SAME backend (src/warlock/modules/crack.py router()):
//   primary poll  GET  /api/crack/status   → {engaged, hashcat, modes, counts,
//                                             hashfiles, wordlists, jobs}
//   submit        POST /api/crack/jobs      {hashfile, wordlist, mode}
//   cancel        POST /api/crack/jobs/{id}/cancel
// Single primary usePoll on /status with the dashboard error guard; everything
// else is derived from that one payload. Cracking is engagement-gated (the
// backend 403s when engagement is OFF) — the pink "!" gate banner mirrors web.
//
// GEOMETRY: reads the live terminal via useStdout() and bounds the layout to the
// rows/cols actually available (fallback 24x120 = design target & test default).
// Panel-at-a-time (CONFIG ⇄ JOBS) keeps height in budget; the jobs list scrolls
// in a fitted window with a "+N more" indicator.
//
// Keys (headless-guarded): Tab swaps CONFIG⇄JOBS panel.
//   CONFIG: ↑/↓ pick field · ←/→ change value · s submit.
//   JOBS:   ↑/↓ scroll/select job · c cancel.
// Free-text target is intentionally omitted (an empty target is gated on
// engagement-on only, like karma) so we never fight the app's global q/g keys.
// ============================================================================

import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

// App shell chrome (top bar + banner + nav wrap + margins + bottom bar). The
// verify harness measures it at ~7; reserve a touch more so we stay under budget.
const CHROME_ROWS = 8;

type Job = {
  id: string;
  hashfile: string;
  hashfile_name: string;
  wordlist_name: string;
  mode: string;
  status: string;
  progress: number;
  speed_hs: number;
  recovered: string | null;
  cracked: string | null;
  error: string | null;
};

type HashFile = { filename: string; path: string; size_bytes: number; mtime?: string };
type WordList = { filename: string; path: string; size_bytes: number };

type CrackStatus = {
  ok: boolean;
  engaged: boolean;
  requires_engagement: boolean;
  hashcat: { path: string; present: boolean };
  modes: string[];
  counts: Record<string, number>;
  hashfiles: HashFile[];
  wordlists: WordList[];
  jobs: Job[];
};

const STATUS_LED: Record<string, LEDColor> = {
  queued: "amber",
  running: "cyan",
  cracked: "mint",
  exhausted: "amber",
  failed: "pink",
  error: "pink",
  cancelled: "dim",
};

function fmtSpeed(hs: number): string {
  if (!hs) return "—";
  if (hs >= 1e9) return `${(hs / 1e9).toFixed(2)} GH/s`;
  if (hs >= 1e6) return `${(hs / 1e6).toFixed(2)} MH/s`;
  if (hs >= 1e3) return `${(hs / 1e3).toFixed(2)} kH/s`;
  return `${hs} H/s`;
}

function fmtKB(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function modeDesc(m: string): string {
  if (m === "22000") return "PMKID+EAPOL";
  if (m === "16800") return "legacy PMKID";
  return "";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mod = (n: number, m: number) => ((n % m) + m) % m;

// Live terminal geometry. ink-testing-library leaves columns/rows undefined →
// fallback to the 120x24 design target so tests stay deterministic.
function useViewport() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 24;
  return { cols, rows, body: Math.max(6, rows - CHROME_ROWS) };
}

// Scrolling window that keeps `sel` visible within `cap` rows.
function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number; more: number } {
  if (cap <= 0 || items.length <= cap) return { slice: items, start: 0, more: Math.max(0, items.length - Math.max(0, cap)) };
  const start = clamp(sel - Math.floor(cap / 2), 0, items.length - cap);
  return { slice: items.slice(start, start + cap), start, more: items.length - cap };
}

// Ink's useInput closure does NOT see fresh values for state the handler itself
// mutates (cursors/panel) — only poll-set state stays current. So action fns and
// branch decisions read these refs (always current), and movement uses functional
// setState updaters (also always current). See the team-lead note on this.
function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export function Screen() {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { cols, body } = useViewport();
  const { data: s, error } = usePoll<CrackStatus>(
    () => api.get<CrackStatus>("/api/crack/status"),
    2000,
    [api],
  );

  const [panel, setPanel] = useState<"config" | "jobs">("config");
  const [field, setField] = useState(0); // 0 hashfile · 1 wordlist · 2 mode
  const [hashIdx, setHashIdx] = useState(0);
  const [wordIdx, setWordIdx] = useState(0);
  const [modeIdx, setModeIdx] = useState(0);
  const [jobSel, setJobSel] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const hashfiles = s?.hashfiles ?? [];
  const wordlists = s?.wordlists ?? [];
  const modes = s?.modes ?? ["22000", "16800"];
  const jobs = s?.jobs ?? [];

  const hi = hashfiles.length ? clamp(hashIdx, 0, hashfiles.length - 1) : 0;
  const wi = wordlists.length ? clamp(wordIdx, 0, wordlists.length - 1) : 0;
  const mi = modes.length ? clamp(modeIdx, 0, modes.length - 1) : 0;
  const ji = jobs.length ? clamp(jobSel, 0, jobs.length - 1) : 0;

  // Refs the input handler reads (see useLive note).
  const sRef = useLive(s);
  const panelRef = useLive(panel);
  const fieldRef = useLive(field);
  const hashIdxRef = useLive(hashIdx);
  const wordIdxRef = useLive(wordIdx);
  const modeIdxRef = useLive(modeIdx);
  const jobSelRef = useLive(jobSel);
  const busyRef = useLive(busy);

  const submit = async () => {
    const st = sRef.current;
    const hfs = st?.hashfiles ?? [];
    const wls = st?.wordlists ?? [];
    const mds = st?.modes ?? ["22000", "16800"];
    const hf = hfs[hfs.length ? clamp(hashIdxRef.current, 0, hfs.length - 1) : 0];
    if (!hf) {
      setNote("select a hashfile first — none captured yet");
      return;
    }
    setBusy(true);
    try {
      const d = await api.post<{ job_id: string }>("/api/crack/jobs", {
        hashfile: hf.path,
        wordlist: wls[wls.length ? clamp(wordIdxRef.current, 0, wls.length - 1) : 0]?.filename,
        mode: mds[mds.length ? clamp(modeIdxRef.current, 0, mds.length - 1) : 0],
      });
      setNote(`queued job ${d.job_id ? d.job_id.slice(0, 8) : "?"} — ${hf.filename}`);
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? "refused (403) — engagement mode must be ON. Activate an engagement on Operations."
          : `submit failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const jbs = sRef.current?.jobs ?? [];
    const j = jbs[jbs.length ? clamp(jobSelRef.current, 0, jbs.length - 1) : 0];
    if (!j) return;
    if (!(j.status === "running" || j.status === "queued")) {
      setNote(`job ${j.id.slice(0, 8)} is ${j.status} — nothing to cancel`);
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/crack/jobs/${j.id}/cancel`);
      setNote(`cancel requested for ${j.id.slice(0, 8)}`);
    } catch (e) {
      setNote(`cancel failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (input, key) => {
      if (key.tab) {
        setPanel((p) => (p === "config" ? "jobs" : "config"));
        return;
      }
      const st = sRef.current;
      const nHash = st?.hashfiles.length ?? 0;
      const nWord = st?.wordlists.length ?? 0;
      const nMode = st?.modes.length ?? 2;
      const nJobs = st?.jobs.length ?? 0;
      if (panelRef.current === "config") {
        if (key.upArrow) setField((f) => clamp(f - 1, 0, 2));
        else if (key.downArrow) setField((f) => clamp(f + 1, 0, 2));
        else if (key.leftArrow || key.rightArrow) {
          const dir = key.leftArrow ? -1 : 1;
          const f = fieldRef.current;
          if (f === 0 && nHash) setHashIdx((v) => mod(v + dir, nHash));
          else if (f === 1 && nWord) setWordIdx((v) => mod(v + dir, nWord));
          else if (f === 2 && nMode) setModeIdx((v) => mod(v + dir, nMode));
        } else if (input === "s" && !busyRef.current) void submit();
      } else {
        if (key.upArrow) setJobSel((v) => clamp(v - 1, 0, Math.max(0, nJobs - 1)));
        else if (key.downArrow) setJobSel((v) => clamp(v + 1, 0, Math.max(0, nJobs - 1)));
        else if (input === "c" && !busyRef.current) void cancel();
      }
    },
    { isActive: rawOk },
  );

  if (error) {
    return (
      <Box flexDirection="column" width={cols - 1}>
        <ModuleHeader code="06 CRACK-Q" title="Crack Queue" state="LINK ERROR" icon="⛓" />
        <Tile title="ERROR" led="pink" width={Math.min(cols, 56)}>
          <Text color={COLORS.pink}>crack error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  if (!s) {
    return (
      <Box flexDirection="column" width={cols - 1}>
        <ModuleHeader code="06 CRACK-Q" title="Crack Queue" state="ACQUIRING" icon="⛓" />
        <Tile title="BOOT" led="amber" width={Math.min(cols, 28)}>
          <Text color={TEXT.dim}>acquiring crack queue…</Text>
        </Tile>
      </Box>
    );
  }

  const counts = s.counts ?? {};
  const active = (counts.running ?? 0) + (counts.queued ?? 0);
  const engaged = !!s.engaged;
  const gated = s.requires_engagement && !engaged;
  const stateLabel = active > 0 ? "CRACKING" : "IDLE";

  // Row accounting → how many job rows fit in the JOBS panel.
  let fixed = 1 /*header*/ + 1 /*stat*/ + 1 /*footer*/;
  if (note) fixed += 1;
  if (gated) fixed += 1;
  // JOBS panel: 1-line config hint + tile chrome (border 2 + title 1 + colheader 1)
  const jobsChrome = 1 + 4;
  const jobsCap = Math.max(1, body - fixed - jobsChrome - 1 /*"+N more" line*/);
  const win = windowOf(jobs, ji, jobsCap);

  const fieldRow = (idx: number, label: string, value: string) => {
    const on = field === idx;
    return (
      <Box>
        <Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text>
        <Box width={10}>
          <Text color={on ? COLORS.violet : TEXT.dim}>{label}</Text>
        </Box>
        <Text color={on ? TEXT.hi : TEXT.body} wrap="truncate-end">
          {value}
        </Text>
        {on ? <Text color={TEXT.dim}> ←/→</Text> : null}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" width={cols - 1}>
      <ModuleHeader
        code="06 CRACK-Q"
        title="Crack Queue"
        state={stateLabel}
        icon="⛓"
        right={<Text color={TEXT.dim}>{active} active</Text>}
      />

      {/* Compact stat strip (replaces the 5-row tile grid to save height) */}
      <Box>
        <StatusLED color={active > 0 ? "cyan" : "amber"} />
        <Text color={TEXT.body}> {active > 0 ? "BUSY" : "IDLE"} </Text>
        <Text color={TEXT.dim}>({counts.running ?? 0}r/{counts.queued ?? 0}q) · </Text>
        <Text color={COLORS.mint}>{counts.cracked ?? 0} cracked</Text>
        <Text color={TEXT.dim}> · hashcat </Text>
        <Text color={s.hashcat?.present ? COLORS.mint : COLORS.pink}>{s.hashcat?.present ? "READY" : "ABSENT"}</Text>
        <Text color={TEXT.dim}> · eng </Text>
        <Text color={engaged ? COLORS.mint : COLORS.amber}>{engaged ? "ON" : "OFF"}</Text>
      </Box>

      {note ? (
        <Box>
          <Text color={COLORS.amber} wrap="truncate-end">» {note}</Text>
        </Box>
      ) : null}

      {gated ? (
        <Text wrap="truncate-end">
          <Text bold color={COLORS.pink}>! ENGAGEMENT OFF</Text>
          <Text color={TEXT.body}> — cracking is gated; submit is refused (403) until an engagement is active.</Text>
        </Text>
      ) : null}

      {panel === "config" ? (
        <>
          <Tile title="SUBMIT CRACK JOB ◂ active" led="violet" width={cols - 1}>
            {fieldRow(
              0,
              "Hashfile",
              hashfiles.length
                ? `${hashfiles[hi].filename} (${fmtKB(hashfiles[hi].size_bytes)})  [${hi + 1}/${hashfiles.length}]`
                : "— no .hc22000 / captures found",
            )}
            {fieldRow(
              1,
              "Wordlist",
              wordlists.length
                ? `${wordlists[wi].filename} (${fmtKB(wordlists[wi].size_bytes)})  [${wi + 1}/${wordlists.length}]`
                : "— none seeded (backend default)",
            )}
            {fieldRow(2, "Mode", `-m ${modes[mi]} (${modeDesc(modes[mi])})`)}
            <Box>
              <Text color={busy ? TEXT.dim : COLORS.amber}>{busy ? "⟳ working…" : "[s] ▶ QUEUE CRACK"}</Text>
              <Text color={TEXT.dim}> · offline, no radio/root</Text>
            </Box>
          </Tile>
          <Text color={TEXT.dim}>
            CRACK JOBS: {jobs.length}
            {active > 0 ? ` (${active} active)` : ""} — Tab to view/cancel
          </Text>
        </>
      ) : (
        <>
          <Tile title={`CRACK JOBS (${jobs.length}) ◂ active`} led={jobs.some((j) => j.status === "running") ? "cyan" : "violet"} width={cols - 1}>
            <Box>
              <Box width={3}><Text color={TEXT.dim}> </Text></Box>
              <Box width={22}><Text color={TEXT.dim}>HASHFILE</Text></Box>
              <Box width={7}><Text color={TEXT.dim}>MODE</Text></Box>
              <Box width={11}><Text color={TEXT.dim}>STATUS</Text></Box>
              <Box width={6}><Text color={TEXT.dim}>PROG</Text></Box>
              <Box width={12}><Text color={TEXT.dim}>SPEED</Text></Box>
              <Box><Text color={TEXT.dim}>RESULT</Text></Box>
            </Box>
            {jobs.length === 0 ? (
              <Text color={TEXT.dim}>no crack jobs yet — capture a .hc22000 then Tab→CONFIG, s to queue</Text>
            ) : (
              win.slice.map((j) => {
                const idx = jobs.indexOf(j);
                const sel = idx === ji;
                return (
                  <Box key={j.id}>
                    <Box width={3}><Text color={sel ? COLORS.violet : TEXT.dim}>{sel ? "› " : "  "}</Text></Box>
                    <Box width={22}><Text color={sel ? TEXT.hi : TEXT.body} wrap="truncate-end">{j.hashfile_name}</Text></Box>
                    <Box width={7}><Text color={TEXT.body}>{j.mode}</Text></Box>
                    <Box width={11}>
                      <StatusLED color={STATUS_LED[j.status] ?? "dim"} />
                      <Text color={TEXT.body}> {j.status}</Text>
                    </Box>
                    <Box width={6}><Text color={TEXT.dim}>{j.progress.toFixed(0)}%</Text></Box>
                    <Box width={12}><Text color={COLORS.cyan}>{fmtSpeed(j.speed_hs)}</Text></Box>
                    <Box>
                      {j.cracked ? (
                        <Text color={COLORS.mint} wrap="truncate-end">{j.cracked}</Text>
                      ) : j.error ? (
                        <Text color={COLORS.pink} wrap="truncate-end">{j.error}</Text>
                      ) : (
                        <Text color={TEXT.dim}>—</Text>
                      )}
                    </Box>
                  </Box>
                );
              })
            )}
            {win.more > 0 ? (
              <Text color={TEXT.dim}>  +{win.more} more — ↑/↓ to scroll ({ji + 1}/{jobs.length})</Text>
            ) : null}
          </Tile>
          <Text color={TEXT.dim}>CONFIG hidden — Tab to edit / submit</Text>
        </>
      )}

      <Box>
        <Text color={TEXT.dim} wrap="truncate-end">
          {panel === "config"
            ? "Tab→JOBS · ↑/↓ field · ←/→ value · s submit"
            : "Tab→CONFIG · ↑/↓ scroll · c cancel"}
        </Text>
      </Box>
    </Box>
  );
}
