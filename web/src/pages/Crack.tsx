import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";
import type { LEDColor } from "../components/hud";

type Job = {
  id: string;
  hashfile: string;
  hashfile_name: string;
  wordlist: string;
  wordlist_name: string;
  mode: string;
  target: string;
  note: string;
  status: string;
  progress: number;
  speed_hs: number;
  recovered: string | null;
  cracked: string | null;
  returncode: number | null;
  error: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type HashFile = { filename: string; path: string; size_bytes: number; mtime: string };
type WordList = { filename: string; path: string; size_bytes: number };

type Counts = Record<string, number>;

type Status = {
  ok: boolean;
  engaged: boolean;
  requires_engagement: boolean;
  hashcat: { path: string; present: boolean };
  modes: string[];
  counts: Counts;
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

const STATUS_TEXT: Record<string, string> = {
  queued: "text-amber-base",
  running: "text-cyan-signal",
  cracked: "text-mint-safe",
  exhausted: "text-amber-base",
  failed: "text-pink-alert",
  error: "text-pink-alert",
  cancelled: "text-txt-dim",
};

function fmtSpeed(hs: number): string {
  if (!hs) return "—";
  if (hs >= 1e9) return `${(hs / 1e9).toFixed(2)} GH/s`;
  if (hs >= 1e6) return `${(hs / 1e6).toFixed(2)} MH/s`;
  if (hs >= 1e3) return `${(hs / 1e3).toFixed(2)} kH/s`;
  return `${hs} H/s`;
}

export function Crack() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [note, setNote] = useState<string>("");

  // submit form
  const [hashfile, setHashfile] = useState<string>("");
  const [wordlist, setWordlist] = useState<string>("");
  const [mode, setMode] = useState<string>("22000");
  const [target, setTarget] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const s = await apiGet<Status>("/api/crack/status");
      setStatus(s);
      if (!hashfile && s.hashfiles[0]) setHashfile(s.hashfiles[0].path);
      if (!wordlist && s.wordlists[0]) setWordlist(s.wordlists[0].filename);
    } catch { /**/ }
  }, [hashfile, wordlist]);

  const loadJobs = useCallback(async () => {
    try {
      const d = await apiGet<{ jobs: Job[] }>("/api/crack/jobs");
      setJobs(d.jobs || []);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    loadJobs();
    const id = setInterval(() => { refresh(); loadJobs(); }, 2000);
    return () => clearInterval(id);
  }, [refresh, loadJobs]);

  const engaged = !!status?.engaged;
  const counts = status?.counts ?? {};
  const active = (counts.running ?? 0) + (counts.queued ?? 0);
  const stateLabel = status == null ? "ACQUIRING" : active > 0 ? "CRACKING" : "IDLE";

  const submit = async () => {
    if (!hashfile) { setNote("select a hashfile first"); return; }
    try {
      const d = await apiPost<{ job_id: string }>("/api/crack/jobs", {
        hashfile,
        wordlist: wordlist || undefined,
        mode,
        target: target || undefined,
      });
      setNote(`queued job ${d.job_id.slice(0, 8)} — ${hashfile.split("/").pop()}`);
      loadJobs();
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? "refused (403) — engagement mode must be ON and the target in scope. Start an engagement first."
          : `submit failed: ${msg}`,
      );
    }
  };

  const cancel = async (id: string) => {
    try {
      await apiPost(`/api/crack/jobs/${id}/cancel`);
      setNote(`cancel requested for ${id.slice(0, 8)}`);
      loadJobs();
    } catch (e) { setNote(`cancel failed: ${e}`); }
  };

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="06 CRACK-Q"
        title="Crack Queue"
        state={stateLabel}
        icon="⛓"
        right={
          <span className="hud-label text-txt-dim">
            hashcat {status?.hashcat?.present ? "ready" : "absent"} · {active} active
          </span>
        }
      />

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      {status && status.requires_engagement && !engaged && (
        <div className="hud-tile border-pink-alert px-3 py-2 text-pink-alert flex items-center gap-2">
          <StatusLED color="pink" />
          <span>
            ENGAGEMENT OFF — cracking is engagement-gated (mirrors the offensive /crack op).
            Submitting a job will be refused with 403 until an engagement is active and the target is in scope.
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
        <Tile title="CRACKED" led={(counts.cracked ?? 0) > 0 ? "mint" : "dim"}>
          <BigValue value={counts.cracked ?? 0} color="mint" size="md" />
        </Tile>
        <Tile title="HASHCAT" led={status?.hashcat?.present ? "mint" : "pink"}>
          <BigValue value={status?.hashcat?.present ? "READY" : "ABSENT"}
            color={status?.hashcat?.present ? "mint" : "pink"} size="md" />
        </Tile>
        <Tile title="ENGAGEMENT" led={engaged ? "mint" : "amber"}>
          <BigValue value={engaged ? "ON" : "OFF"} color={engaged ? "mint" : "amber"} size="md" />
        </Tile>
      </div>

      <Tile title="SUBMIT CRACK JOB" led={engaged ? "mint" : "violet"}>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="hud-label block mb-1">Hashfile (.hc22000)</label>
              <select
                className="hud-btn w-full bg-bg-strip"
                value={hashfile}
                onChange={(e) => setHashfile(e.target.value)}
              >
                {(status?.hashfiles ?? []).length === 0 && <option value="">no .hc22000 captures found</option>}
                {(status?.hashfiles ?? []).map((h) => (
                  <option key={h.path} value={h.path}>
                    {h.filename} ({(h.size_bytes / 1024).toFixed(1)} KB)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="hud-label block mb-1">Wordlist</label>
              <select
                className="hud-btn w-full bg-bg-strip"
                value={wordlist}
                onChange={(e) => setWordlist(e.target.value)}
              >
                {(status?.wordlists ?? []).length === 0 && <option value="">no wordlists seeded</option>}
                {(status?.wordlists ?? []).map((w) => (
                  <option key={w.path} value={w.filename}>
                    {w.filename} ({(w.size_bytes / 1024 / 1024).toFixed(1)} MB)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="hud-label block mb-1">Mode</label>
              <select
                className="hud-btn w-full bg-bg-strip"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                {(status?.modes ?? ["22000", "16800"]).map((m) => (
                  <option key={m} value={m}>
                    {m} {m === "22000" ? "(PMKID+EAPOL)" : "(legacy PMKID)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="hud-label block mb-1">Target BSSID/ESSID (scope-checked)</label>
              <input
                className="hud-btn w-full bg-bg-strip tabular-nums"
                value={target}
                placeholder="aa:bb:cc:dd:ee:ff or SSID"
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
          </div>
          <button
            className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
            onClick={submit}
            disabled={!hashfile}
          >
            ▶ QUEUE CRACK
          </button>
          <div className="text-txt-dim text-[0.75rem]">
            Runs <code className="text-violet-bright">hashcat -m {mode} -a 0</code> over the selected hash + wordlist
            in the background (offline — no radio, no root). Progress is parsed live from{" "}
            <code className="text-violet-bright">--status-json</code>; the recovered passphrase lands in{" "}
            <code className="text-violet-bright">~/warlock/captures/wifi/cracked/</code>.
          </div>
        </div>
      </Tile>

      <JobsTable jobs={jobs} onCancel={cancel} />
    </div>
  );
}

function JobsTable({ jobs, onCancel }: { jobs: Job[]; onCancel: (id: string) => void }) {
  return (
    <Tile title="CRACK JOBS" padded={false} led={jobs.some((j) => j.status === "running") ? "cyan" : "violet"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">Hashfile</th>
              <th className="hud-label px-3 py-2 text-left">Wordlist</th>
              <th className="hud-label px-3 py-2 text-left">Mode</th>
              <th className="hud-label px-3 py-2 text-left">Status</th>
              <th className="hud-label px-3 py-2 text-left">Progress</th>
              <th className="hud-label px-3 py-2 text-left">Speed</th>
              <th className="hud-label px-3 py-2 text-left">Result</th>
              <th className="hud-label px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-4 text-txt-dim">
                no crack jobs yet — queue one above (needs a captured .hc22000 + active engagement)
              </td></tr>
            )}
            {jobs.map((j) => {
              const active = j.status === "running" || j.status === "queued";
              return (
                <tr key={j.id} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 text-txt-body" title={j.hashfile}>{j.hashfile_name}</td>
                  <td className="px-3 py-1 text-txt-dim">{j.wordlist_name}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-body">{j.mode}</td>
                  <td className="px-3 py-1">
                    <span className="inline-flex items-center gap-2">
                      <StatusLED color={STATUS_LED[j.status] ?? "dim"} />
                      <span className={STATUS_TEXT[j.status] ?? "text-txt-body"}>{j.status}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1 w-40">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 bg-line-dim/40 overflow-hidden">
                        <div
                          className={"h-full " + (j.status === "cracked" ? "bg-mint-safe" : "bg-cyan-signal")}
                          style={{ width: `${Math.max(0, Math.min(100, j.progress))}%` }}
                        />
                      </div>
                      <span className="tabular-nums text-txt-dim w-12 text-right">{j.progress.toFixed(0)}%</span>
                    </div>
                    {j.recovered && <span className="text-txt-dim text-[0.7rem]">rec {j.recovered}</span>}
                  </td>
                  <td className="px-3 py-1 tabular-nums text-cyan-signal">{fmtSpeed(j.speed_hs)}</td>
                  <td className="px-3 py-1">
                    {j.cracked
                      ? <span className="text-mint-safe font-semibold break-all">{j.cracked}</span>
                      : j.error
                        ? <span className="text-pink-alert text-[0.7rem]">{j.error}</span>
                        : <span className="text-txt-dim">—</span>}
                  </td>
                  <td className="px-3 py-1">
                    <button
                      className="hud-btn border-pink-alert text-pink-alert disabled:opacity-30"
                      onClick={() => onCancel(j.id)}
                      disabled={!active}
                    >
                      ■ cancel
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}
