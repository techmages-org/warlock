// ============================================================================
// OFFENSIVE WIFI (wifi_offensive) — engagement-GATED active attacks. The web
// page is a stub, so this is built REAL from src/warlock/modules/wifi_offensive.py
// router():
//   primary poll  GET  /api/wifi_offensive/status  → {engaged, requires_engagement,
//                       iface{managed,monitor}, ops, captures, wordlists, recent_jobs}
//   targets       GET  /api/wifi_recon/aps          (recon feeds targeting)
//   fire ops      POST /api/wifi_offensive/{deauth,handshake,pmkid,evil_twin,karma,wps}
// Every op is engagement-gated server-side (403 when OFF / out-of-scope). The
// pink "!" gate banner mirrors the web; ops are visibly BLOCKED when engagement
// is off, exactly like the nav "!" flag.
//
// GEOMETRY: reads the live terminal via useStdout() and bounds the layout to the
// rows/cols available (fallback 24x120 = design target & test default). The OPS
// menu is a compact 2-line strip; the TARGETS list scrolls in a fitted window
// with a "+N more" indicator so a busy recon never overflows.
//
// Keys (headless-guarded): ↑/↓ scroll target · ←/→ select op · Enter fire.
// ============================================================================

import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT } from "../lib/theme.js";

const CHROME_ROWS = 8;

type AP = { bssid: string; essid: string; channel: number; encryption: string; signal: number; wps: boolean };
type Job = { id: string; type: string; status: string; started_at: string | null; finished_at: string | null };
type Capture = { path: string; filename: string; kind: string; size_bytes: number };

type OffStatus = {
  ok: boolean;
  engaged: boolean;
  requires_engagement: boolean;
  iface: { managed: string; monitor: string };
  ops: string[];
  captures: Capture[];
  wordlists: { filename: string; path: string; size_bytes: number }[];
  recent_jobs: Job[];
};

type Op = {
  key: string;
  label: string;
  desc: string;
  path: string;
  needsTarget: boolean;
  build: (ap: AP | undefined) => Record<string, unknown>;
};

// Launch ops (the /crack op is handled by the Crack screen, so it's excluded).
const OPS: Op[] = [
  { key: "deauth", label: "Deauth", desc: "aireplay-ng deauth burst vs AP", path: "/api/wifi_offensive/deauth", needsTarget: true, build: (a) => ({ bssid: a!.bssid, count: 64 }) },
  { key: "handshake", label: "Capture-HS", desc: "deauth + airodump EAPOL capture", path: "/api/wifi_offensive/handshake", needsTarget: true, build: (a) => ({ bssid: a!.bssid, channel: a!.channel || 1 }) },
  { key: "pmkid", label: "PMKID", desc: "hcxdumptool clientless .hc22000", path: "/api/wifi_offensive/pmkid", needsTarget: true, build: (a) => ({ bssid: a!.bssid, duration: 60 }) },
  { key: "evil_twin", label: "Evil-Twin", desc: "airbase-ng rogue AP + portal (needs SSID)", path: "/api/wifi_offensive/evil_twin", needsTarget: true, build: (a) => ({ ssid: a!.essid, channel: a!.channel || 1 }) },
  { key: "karma", label: "Karma", desc: "answers ALL probes (no target SSID)", path: "/api/wifi_offensive/karma", needsTarget: false, build: (a) => ({ channel: a?.channel || 1 }) },
  { key: "wps", label: "WPS", desc: "reaver WPS PIN attack", path: "/api/wifi_offensive/wps", needsTarget: true, build: (a) => ({ bssid: a!.bssid, channel: a!.channel || 1, tool: "reaver" }) },
];

const JOB_LED: Record<string, "amber" | "cyan" | "mint" | "pink" | "dim"> = {
  queued: "amber", running: "cyan", succeeded: "mint", done: "mint", finished: "mint", failed: "pink", error: "pink", cancelled: "dim",
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function useViewport() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 24;
  return { cols, rows, body: Math.max(6, rows - CHROME_ROWS) };
}
function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; more: number } {
  if (cap <= 0 || items.length <= cap) return { slice: items, more: Math.max(0, items.length - Math.max(0, cap)) };
  const start = clamp(sel - Math.floor(cap / 2), 0, items.length - cap);
  return { slice: items.slice(start, start + cap), more: items.length - cap };
}
function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

function opBlocked(op: Op, target: AP | undefined, engaged: boolean): boolean {
  return !engaged || (op.needsTarget && !target) || (op.key === "evil_twin" && !target?.essid);
}

export function Screen() {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { cols, body } = useViewport();
  const { data: s, error } = usePoll<OffStatus>(
    () => api.get<OffStatus>("/api/wifi_offensive/status"),
    2000,
    [api],
  );

  const [aps, setAps] = useState<AP[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const [opIdx, setOpIdx] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await api.get<{ aps: AP[] }>("/api/wifi_recon/aps");
        if (alive) setAps(d.aps || []);
      } catch {
        /* silent — primary /status drives the error frame */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api]);

  const engaged = !!s?.engaged;

  const apsRef = useLive(aps);
  const engagedRef = useLive(engaged);
  const targetIdxRef = useLive(targetIdx);
  const opIdxRef = useLive(opIdx);
  const busyRef = useLive(busy);

  const fire = async () => {
    const op = OPS[clamp(opIdxRef.current, 0, OPS.length - 1)];
    const list = apsRef.current;
    const ap = list[clamp(targetIdxRef.current, 0, Math.max(0, list.length - 1))];
    if (!engagedRef.current) {
      setNote(`! ${op.label} BLOCKED — engagement OFF. Activate an engagement (Ctrl+E) with the target in scope.`);
      return;
    }
    if (op.needsTarget && !ap) {
      setNote("select a target AP first (↑/↓) — arm WiFi Recon if the list is empty");
      return;
    }
    if (op.key === "evil_twin" && !ap?.essid) {
      setNote("evil-twin needs a visible SSID — the selected target is hidden");
      return;
    }
    setBusy(true);
    try {
      const d = await api.post<{ job_id?: string }>(op.path, op.build(ap));
      setNote(`${op.label} launched — job ${d.job_id ? d.job_id.slice(0, 8) : "?"}${ap ? ` vs ${ap.bssid}` : ""}`);
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? `${op.label} refused (403) — target not in engagement scope. Add it on Operations.`
          : `${op.label} failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (_input, key) => {
      const n = apsRef.current.length;
      // ←/→ always select the op. ↑/↓ scroll targets when any exist, else fall
      // back to op selection so the screen is never inert (empty recon list).
      if (key.leftArrow) setOpIdx((v) => clamp(v - 1, 0, OPS.length - 1));
      else if (key.rightArrow) setOpIdx((v) => clamp(v + 1, 0, OPS.length - 1));
      else if (key.upArrow) {
        if (n > 0) setTargetIdx((v) => clamp(v - 1, 0, n - 1));
        else setOpIdx((v) => clamp(v - 1, 0, OPS.length - 1));
      } else if (key.downArrow) {
        if (n > 0) setTargetIdx((v) => clamp(v + 1, 0, n - 1));
        else setOpIdx((v) => clamp(v + 1, 0, OPS.length - 1));
      } else if (key.return && !busyRef.current) void fire();
    },
    { isActive: rawOk },
  );

  if (error) {
    return (
      <Box flexDirection="column" width={cols - 1}>
        <ModuleHeader code="07 WIFI-OFF" title="Offensive WiFi" state="LINK ERROR" icon="⚠" />
        <Tile title="ERROR" led="pink" width={Math.min(cols - 1, 56)}>
          <Text color={COLORS.pink}>wifi_offensive error: {error}</Text>
        </Tile>
      </Box>
    );
  }
  if (!s) {
    return (
      <Box flexDirection="column" width={cols - 1}>
        <ModuleHeader code="07 WIFI-OFF" title="Offensive WiFi" state="ACQUIRING" icon="⚠" />
        <Tile title="BOOT" led="amber" width={Math.min(cols - 1, 28)}>
          <Text color={TEXT.dim}>acquiring offensive state…</Text>
        </Tile>
      </Box>
    );
  }

  const ti = aps.length ? clamp(targetIdx, 0, aps.length - 1) : 0;
  const oi = clamp(opIdx, 0, OPS.length - 1);
  const target = aps[ti];
  const jobs = s.recent_jobs ?? [];
  const caps = s.captures ?? [];
  const op = OPS[oi];
  const blocked = opBlocked(op, target, engaged);

  // Rows for the TARGETS scroll window.
  let fixed = 1 /*header*/ + 1 /*gate*/ + 1 /*stat*/ + 1 /*footer*/;
  if (note) fixed += 1;
  const opsChrome = 2 /*border*/ + 1 /*title*/ + 1 /*labels*/ + 1 /*detail*/; // = 5
  const tgtChrome = 2 /*border*/ + 1 /*title*/ + 1 /*colheader*/; // = 4
  const cap = Math.max(1, body - fixed - opsChrome - tgtChrome - 1 /*"+N more"*/);
  const win = windowOf(aps, ti, cap);

  return (
    <Box flexDirection="column" width={cols - 1}>
      <ModuleHeader
        code="07 WIFI-OFF"
        title="Offensive WiFi"
        state={engaged ? "ENGAGED" : "SAFE"}
        icon="⚠"
        right={<Text color={TEXT.dim}>{s.iface?.monitor ?? "mon0"} · {caps.length}cap · {jobs.length}job</Text>}
      />

      {/* Engagement gate — pink "!" mirror of the web/nav flag (one Text, no wrap) */}
      {engaged ? (
        <Text wrap="truncate-end">
          <Text color={COLORS.mint}>◎ ENGAGED</Text>
          <Text color={TEXT.body}> — in-scope ops launch; an out-of-scope target still 403s.</Text>
        </Text>
      ) : (
        <Text wrap="truncate-end">
          <Text bold color={COLORS.pink}>! ENGAGEMENT REQUIRED</Text>
          <Text color={TEXT.body}> — ops are gated; every launch is refused (403) until active. Ctrl+E → Operations.</Text>
        </Text>
      )}

      {/* Compact stat strip */}
      <Box>
        <StatusLED color={engaged ? "pink" : "amber"} />
        <Text color={engaged ? COLORS.pink : COLORS.amber}> {engaged ? "ENGAGED" : "SAFE"} </Text>
        <Text color={TEXT.dim}>· mon </Text>
        <Text color={COLORS.violet}>{s.iface?.monitor ?? "mon0"}</Text>
        <Text color={TEXT.dim}> · target </Text>
        <Text color={target ? COLORS.cyan : TEXT.dim} wrap="truncate-end">
          {target ? `${target.essid || "—hidden"} ${target.bssid}` : "none"}
        </Text>
      </Box>

      {note ? (
        <Box>
          <Text color={note.startsWith("!") ? COLORS.pink : COLORS.amber} wrap="truncate-end">» {note}</Text>
        </Box>
      ) : null}

      {/* OPS — compact 2-line menu (←/→ select · Enter fire) */}
      <Tile title="OPS  (←/→ select · Enter fire)" led={engaged ? "pink" : "amber"} width={cols - 1}>
        <Box>
          {OPS.map((o, idx) => {
            const sel = idx === oi;
            const b = opBlocked(o, target, engaged);
            return (
              <Text key={o.key} color={sel ? (b ? COLORS.pink : COLORS.violet) : b ? TEXT.dim : TEXT.body} bold={sel}>
                {sel ? "[" : " "}{o.label}{sel ? "]" : " "}
              </Text>
            );
          })}
        </Box>
        <Box>
          <Text color={blocked ? COLORS.pink : COLORS.mint}>{blocked ? "BLOCKED" : "READY"}</Text>
          <Text color={TEXT.dim} wrap="truncate-end">
            {" "}{op.label}: {op.desc}{busy ? "  ⟳ launching…" : ""}
          </Text>
        </Box>
      </Tile>

      {/* TARGETS — recon APs, scrolling window */}
      <Tile title={`TARGETS — recon APs (${aps.length})`} led={aps.length ? "mint" : "amber"} width={cols - 1}>
        <Box>
          <Box width={3}><Text color={TEXT.dim}> </Text></Box>
          <Box width={20}><Text color={TEXT.dim}>BSSID</Text></Box>
          <Box width={22}><Text color={TEXT.dim}>ESSID</Text></Box>
          <Box width={5}><Text color={TEXT.dim}>CH</Text></Box>
          <Box width={10}><Text color={TEXT.dim}>ENC</Text></Box>
          <Box><Text color={TEXT.dim}>SIG</Text></Box>
        </Box>
        {aps.length === 0 ? (
          <Text color={TEXT.dim}>no targets — arm WiFi Recon (g w → Control → s) to populate the AP list</Text>
        ) : (
          win.slice.map((a) => {
            const sel = aps.indexOf(a) === ti;
            return (
              <Box key={a.bssid}>
                <Box width={3}><Text color={sel ? COLORS.violet : TEXT.dim}>{sel ? "› " : "  "}</Text></Box>
                <Box width={20}><Text color={sel ? TEXT.hi : TEXT.body}>{a.bssid}</Text></Box>
                <Box width={22}><Text color={a.essid ? COLORS.violet : TEXT.dim} wrap="truncate-end">{a.essid || "— hidden"}</Text></Box>
                <Box width={5}><Text color={TEXT.body}>{a.channel || "?"}</Text></Box>
                <Box width={10}><Text color={TEXT.body}>{a.encryption || "?"}{a.wps ? " W" : ""}</Text></Box>
                <Box><Text color={COLORS.cyan}>{a.signal}</Text></Box>
              </Box>
            );
          })
        )}
        {win.more > 0 ? (
          <Text color={TEXT.dim}>  +{win.more} more — ↑/↓ to scroll ({ti + 1}/{aps.length})</Text>
        ) : null}
      </Tile>

      <Box>
        <Text color={TEXT.dim} wrap="truncate-end">
          ↑/↓ target · ←/→ op · Enter fire
          {jobs.length ? ` · recent: ${jobs[0].type} ` : ""}
          {jobs.length ? <Text color={COLORS[JOB_LED[jobs[0].status] ?? "dim"]}>{jobs[0].status}</Text> : ""}
        </Text>
      </Box>
    </Box>
  );
}
