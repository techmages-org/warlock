#!/usr/bin/env node
// =============================================================================
// W6 — On-device verification of all 16 Ink screens vs the LIVE deck.
// VERIFY-ONLY: read-only imports of the screen registry; never edits screens.
//
// Two geometries (real deck console is 160x45 per `stty size` on deck tty1):
//   • PRIMARY (deck console):   160 x 45
//   • STRESS  (small SSH/term): 120 x 24
//
// Mechanic split (each tool for what it's actually good at):
//   • Geometry  → a controllable custom stdout + Ink `debug:true` (full-frame
//     writes). ink-testing-library has NO column knob, so it can't measure at
//     160 vs 120 — the custom stdout can.
//   • Interaction → ink-testing-library, whose stdin.write() actually delivers
//     keys to useInput (a hand-rolled stdin does NOT — verified the hard way).
//
// Live deck, real fetches, no mocks. Run:
//   npx tsx scripts/ondevice-verify.tsx \
//     --api http://<deck-host>:7777 --user <user> --password <pass>
//   add --fire-enter to also send Enter in the interaction probe (DESTRUCTIVE on
//   live hardware — off by default; see the safety note in the report).
// =============================================================================

import { render } from "ink";
import { render as renderItl } from "ink-testing-library";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import React from "react";
import type { ReactElement } from "react";

import { WarlockProvider, type WarlockContextValue } from "../src/context.js";
import { createApiClient } from "../src/lib/api.js";
import { parseConfig, type Config } from "../src/lib/config.js";
import type { EventBus } from "../src/lib/ws.js";
import { App } from "../src/app.js";
import { SCREENS } from "../src/screens/registry.js";

const h = React.createElement;

// string width (double-width-glyph aware), codepoint fallback.
let stringWidth: (s: string) => number;
try {
  stringWidth = (await import("string-width")).default;
} catch {
  stringWidth = (s: string) => [...s].length;
}

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
};
const has = (name: string) => argv.some((a) => a === name || a.startsWith(name + "="));

const SETTLE = Number(flag("--settle") ?? 4000);
const FIRE_ENTER = has("--fire-enter");
const REPORT_PATH = flag("--out") ?? "/tmp/warlock-ondevice-verify.md";

const base = parseConfig(argv);
const config: Config = {
  apiUrl: has("--api") || has("--url") ? base.apiUrl : "http://127.0.0.1:7777",
  auth: base.auth,
};

const GEOMS = [
  { key: "deck", label: "160×45", cols: 160, rows: 45 },
  { key: "stress", label: "120×24", cols: 120, rows: 24 },
] as const;

// Worker ownership (subctl teammate names), for triage routing.
const OWNER: Record<string, string> = {
  dashboard: "ink-foundation",
  wireless: "ink-red", wifi_recon: "ink-red", wifi_offensive: "ink-red", crack: "ink-red",
  wireless_ids: "ink-blue", net_recon: "ink-blue", server_audit: "ink-blue",
  sdr: "ink-radio", sdr_offensive: "ink-radio", gps: "ink-radio", mesh: "ink-radio",
  ops: "ink-ops", system: "ink-ops", audio: "ink-ops", esp32_companion: "ink-ops",
};

// Screens to interaction-probe (per team-lead's list — cursor/form/tab screens).
const INTERACT = new Set([
  "wireless", "wifi_recon", "wifi_offensive", "crack", "net_recon", "server_audit",
  "sdr", "sdr_offensive", "gps", "mesh", "ops", "system", "audio",
]);

const SCREEN_ORDER = [
  "dashboard", "wireless", "wifi_recon", "wifi_offensive", "crack",
  "wireless_ids", "net_recon", "server_audit", "sdr", "sdr_offensive",
  "gps", "mesh", "ops", "system", "audio", "esp32_companion",
].filter((id) => id in SCREENS);

// ---- controllable stdout/stdin for the geometry pass ------------------------
class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  isTTY = true;
  lastFrameValue = "";
  constructor(cols: number, rows: number) {
    super();
    this.columns = cols;
    this.rows = rows;
  }
  write = (data: string): boolean => {
    // Ink writes cursor-control escapes (e.g. ESC[?25l) as their own writes; pin
    // lastFrame to the most recent CONTENT-bearing frame, not the trailing escape.
    if (data.replace(ANSI, "").trim() !== "") this.lastFrameValue = data;
    return true;
  };
  lastFrame = (): string => this.lastFrameValue;
}
class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  write = (d: string): void => {
    this.emit("data", d);
  };
  read = (): null => null;
}

// ---- helpers ----------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ANSI = /\[[0-9;?]*[A-Za-z]/g;
const strip = (s: string) => s.replace(ANSI, "").replace(/\r/g, "");
const ESC = String.fromCharCode(27);

const LOADING_RE = /acquiring|booting|loading|fetching|no data yet/i;
async function settleLoop(getFrame: () => string, settle: number): Promise<void> {
  const start = Date.now();
  let prev = "";
  let stable = 0;
  while (Date.now() - start < settle) {
    await sleep(300);
    const cur = getFrame();
    const loading = cur === "" || LOADING_RE.test(strip(cur));
    if (!loading && cur === prev) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
      prev = cur;
    }
  }
}

function measure(frame: string): { height: number; width: number; text: string } {
  const lines = strip(frame).split("\n");
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  // Trailing-trim per line: Ink pads each row with spaces out to the root box /
  // terminal width, so raw line length == cols (false). Measure the rightmost
  // NON-space column = true content width.
  const width = lines.reduce((m, l) => Math.max(m, stringWidth(l.replace(/\s+$/u, ""))), 0);
  return { height: lines.length, width, text: lines.join("\n") };
}

function modLine(text: string): string {
  const m = text.split("\n").find((l) => l.includes("MOD //"));
  return m ? m.trim().replace(/\s{2,}/g, " ").slice(0, 64) : "";
}

type RenderState = "ok" | "error" | "loading" | "crash";
function classify(text: string, crashed: string | null): RenderState {
  if (crashed) return "crash";
  if (/link error|\berror:|\berror\b|cannot read|is not a function|typeerror|traceback|undefined is not/i.test(text))
    return "error";
  if (LOADING_RE.test(text)) return "loading";
  return "ok";
}

let currentId = "";
let asyncCrash: string | null = null;

// Geometry render at an exact COLS x ROWS via the custom stdout.
async function renderAt(
  el: ReactElement,
  cols: number,
  rows: number,
  settle = SETTLE,
): Promise<{ frame: string; crash: string | null }> {
  asyncCrash = null;
  const stdout = new FakeStdout(cols, rows);
  const stderr = new FakeStdout(cols, rows);
  const stdin = new FakeStdin();
  try {
    const inst = render(el, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdin: stdin as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stderr: stderr as any,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await settleLoop(() => stdout.lastFrame(), settle);
    const frame = stdout.lastFrame();
    inst.unmount();
    return { frame, crash: asyncCrash };
  } catch (e) {
    return { frame: stdout.lastFrame(), crash: (e instanceof Error ? e.message : String(e)) };
  }
}

const ctx = (): WarlockContextValue => ({
  config,
  api: createApiClient(config),
  bus: { subscribe: () => () => {}, close: () => {} } satisfies EventBus,
});

// =============================================================================
async function main() {
  process.on("uncaughtException", (e) => {
    asyncCrash = `uncaught: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`  ! [${currentId}] ${asyncCrash}`);
  });
  process.on("unhandledRejection", (e) => {
    asyncCrash = `rejection: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`  ! [${currentId}] ${asyncCrash}`);
  });

  const api = createApiClient(config);
  console.error(`# Warlock TUI on-device verify @ ${config.apiUrl}`);
  try {
    const v = await api.get<{ name: string; version: string }>("/api/version");
    const mods = await api.get<unknown[]>("/api/modules");
    console.error(`  deck OK: ${v.name} v${v.version} · ${mods.length} modules\n`);
  } catch (e) {
    console.error(`  DECK UNREACHABLE: ${e instanceof Error ? e.message : String(e)} — aborting (no faked results).`);
    process.exit(2);
  }

  // ---- chrome (app shell) height per geometry: App total − dashboard body ----
  const chrome: Record<string, number> = {};
  for (const g of GEOMS) {
    currentId = `app@${g.label}`;
    const appR = await renderAt(h(WarlockProvider, { value: ctx() }, h(App)), g.cols, g.rows, 4500);
    const dashR = await renderAt(h(WarlockProvider, { value: ctx() }, h(SCREENS.dashboard!)), g.cols, g.rows);
    const appH = measure(appR.frame).height;
    const dashH = measure(dashR.frame).height;
    chrome[g.key] = appH > dashH ? appH - dashH : 7;
    console.error(`  chrome@${g.label} = ${chrome[g.key]} rows (app ${appH} − dash body ${dashH})`);
  }
  console.error("");

  type Row = {
    id: string;
    owner: string;
    h: Record<string, number>;
    w: Record<string, number>;
    state: RenderState;
    realData: string;
    mod: string;
    interact: string;
    verdict: "PASS" | "WARN" | "FAIL";
    issue: string;
  };
  const rows: Row[] = [];

  // ---- PASS 1: geometry + render-state at BOTH geometries -------------------
  // Measure width at EACH geometry vs that geometry's cols. Responsive screens
  // (justifyContent space-between, flexGrow) fill the terminal → width==cols at
  // both, which is FINE (fits, no wrap). Only FIXED-width rows wider than the
  // terminal stay constant across geometries and genuinely overflow.
  console.error("Pass 1 — geometry @ 160×45 (deck) and 120×24 (stress):");
  for (const id of SCREEN_ORDER) {
    const Screen = SCREENS[id]!;
    const hgt: Record<string, number> = {};
    const wdt: Record<string, number> = {};
    let state: RenderState = "ok";
    let mod = "";
    for (const g of GEOMS) {
      currentId = `${id}@${g.label}`;
      const { frame, crash } = await renderAt(h(WarlockProvider, { value: ctx() }, h(Screen)), g.cols, g.rows);
      const m = measure(frame);
      hgt[g.key] = m.height;
      wdt[g.key] = m.width;
      if (g.key === "deck") {
        state = classify(m.text, crash);
        mod = modLine(m.text);
      }
    }
    const realData = state === "ok" ? "live" : state;
    rows.push({ id, owner: OWNER[id] ?? "?", h: hgt, w: wdt, state, realData, mod, interact: "—", verdict: "PASS", issue: "" });
    console.error(`  ${id.padEnd(16)} 160×45 h=${String(hgt.deck).padStart(2)} w=${String(wdt.deck).padStart(3)}  120×24 h=${String(hgt.stress).padStart(2)} w=${String(wdt.stress).padStart(3)}  ${state}`);
  }

  // ---- PASS 2: interaction probe (itl delivers input) ----------------------
  console.error(`\nPass 2 — interaction probe (Tab ↓ ↓${FIRE_ENTER ? " + Enter" : ""}):`);
  const keys = FIRE_ENTER ? ["\t", ESC + "[B", ESC + "[B", "\r"] : ["\t", ESC + "[B", ESC + "[B"];
  for (const id of SCREEN_ORDER) {
    if (!INTERACT.has(id)) continue;
    const Screen = SCREENS[id]!;
    currentId = `${id}#input`;
    let inst: ReturnType<typeof renderItl> | null = null;
    let mountCrash: string | null = null;
    try {
      inst = renderItl(h(WarlockProvider, { value: ctx() }, h(Screen)));
    } catch (e) {
      mountCrash = e instanceof Error ? e.message : String(e);
    }
    const row = rows.find((r) => r.id === id)!;
    if (!inst) {
      row.interact = `CRASH on mount: ${mountCrash}`;
      console.error(`  ${id.padEnd(16)} CRASH mount`);
      continue;
    }
    const view = inst;
    await settleLoop(() => view.lastFrame() ?? "", SETTLE);
    const before = strip(view.lastFrame() ?? "");
    let probeCrash: string | null = null;
    try {
      for (const k of keys) {
        view.stdin.write(k);
        await sleep(180);
      }
    } catch (e) {
      probeCrash = e instanceof Error ? e.message : String(e);
    }
    await sleep(250);
    const after = strip(view.lastFrame() ?? "");
    const moved = before !== after;
    row.interact = probeCrash
      ? `CRASH: ${probeCrash}`
      : moved
        ? "frame updated (cursor/panel responds)"
        : "no frame change (empty selection or review for staleness)";
    console.error(`  ${id.padEnd(16)} ${moved ? "moved " : "static"} ${probeCrash ? "CRASH" : "ok"}`);
    view.unmount();
    await sleep(100);
  }

  // ---- verdicts ------------------------------------------------------------
  const deckBudget = 45 - chrome.deck;
  const stressBudget = 24 - chrome.stress;
  for (const r of rows) {
    const deckOverH = Math.max(0, chrome.deck + r.h.deck - 45);
    const stressOverH = Math.max(0, chrome.stress + r.h.stress - 24);
    // Width vs the SAME geometry's cols. width==cols = responsive fill (fine);
    // width>cols = fixed-width content overflowing that terminal (real).
    const deckOverW = Math.max(0, r.w.deck - 160);
    const stressOverW = Math.max(0, r.w.stress - 120);
    const inputCrash = r.interact.startsWith("CRASH");
    const issues: string[] = [];
    if (r.state === "crash" || inputCrash) issues.push("RENDER/INPUT CRASH");
    if (deckOverH > 0) issues.push(`height +${deckOverH} over deck 45`);
    if (deckOverW > 0) issues.push(`width ${r.w.deck}>160 — clips on DECK`);
    if (r.state === "error") issues.push("error tile (endpoint down? confirm)");
    if (stressOverH > 0) issues.push(`+${stressOverH} rows over 120×24 SSH`);
    if (stressOverW > 0) issues.push(`width ${r.w.stress}>120 — clips on small SSH`);
    if (r.state === "loading") issues.push("stuck loading (slow/absent endpoint)");
    // NOTE: "static under input" is NOT a verdict driver — many screens are
    // display-only (no list cursor) so no frame change is correct. Static input
    // screens are surfaced separately as staleness-review candidates below.

    if (r.state === "crash" || inputCrash || deckOverH > 0 || deckOverW > 0) r.verdict = "FAIL";
    else if (issues.length > 0) r.verdict = "WARN";
    else r.verdict = "PASS";
    r.issue = issues.join("; ");
  }

  // ---- report --------------------------------------------------------------
  const fails = rows.filter((r) => r.verdict === "FAIL");
  const warns = rows.filter((r) => r.verdict === "WARN");
  const L: string[] = [];
  L.push("# Warlock TUI — on-device verification (W6)");
  L.push("");
  L.push(`- **Deck:** ${config.apiUrl} (live, real fetches — no mocks)`);
  L.push(`- **Geometry:** PRIMARY = **160×45** (real deck console, measured via \`stty size\`); STRESS = **120×24** (small SSH/terminal).`);
  L.push(`- **Chrome (app shell):** ${chrome.deck} rows @160×45 → body budget **${deckBudget}**; ${chrome.stress} rows @120×24 → body budget **${stressBudget}**. On-device total = chrome + screen body.`);
  L.push(`- **Interaction:** itl delivers real keys to \`useInput\`. Default probe = Tab + ↓ + ↓ (non-destructive; frame-change = handler-state updates → detects the staleness bug). **Enter NOT fired by default** — on the live deck it would trigger real ops (wifi_recon→monitor, scans, and the ops screen's engagement-activate/killswitch). Re-run with \`--fire-enter\` for a controlled "act" pass.`);
  L.push(`- **Summary:** ${rows.length} screens · ${rows.filter((r) => r.state === "ok").length} render live OK · ${fails.length} FAIL · ${warns.length} WARN.`);
  L.push("");

  L.push(`## Verdicts — FAIL (${fails.length}) / WARN (${warns.length})`);
  L.push("");
  if (fails.length + warns.length === 0) {
    L.push("None — every screen fits the deck console, renders live data, and survives the input probe.");
  } else {
    L.push("| screen | owner | verdict | issue |");
    L.push("|---|---|---|---|");
    for (const r of [...fails, ...warns]) L.push(`| ${r.id} | ${r.owner} | ${r.verdict} | ${r.issue} |`);
  }
  L.push("");

  L.push("## All 16 screens");
  L.push("");
  L.push("| screen | h@160×45 | h@120×24 | w@160 | w@120 | render | real-data | interaction | verdict | issue + owner |");
  L.push("|---|--:|--:|--:|--:|---|---|---|---|---|");
  for (const r of rows) {
    const dh = chrome.deck + r.h.deck > 45 ? `**${r.h.deck}** ⚠` : `${r.h.deck}`;
    const sh = chrome.stress + r.h.stress > 24 ? `**${r.h.stress}** ⚠` : `${r.h.stress}`;
    const wd = r.w.deck > 160 ? `**${r.w.deck}** ⚠` : `${r.w.deck}`;
    const ws = r.w.stress > 120 ? `**${r.w.stress}** ⚠` : `${r.w.stress}`;
    const issueOwner = r.issue ? `${r.issue} → ${r.owner}` : "";
    L.push(`| ${r.id} | ${dh} | ${sh} | ${wd} | ${ws} | ${r.state} | ${r.realData} | ${r.interact} | ${r.verdict} | ${issueOwner} |`);
  }
  L.push("");
  L.push("## Interaction (useInput) — staleness review");
  L.push("");
  L.push("Probe = Tab + ↓ + ↓ (real keys delivered via ink-testing-library). Screens that visibly respond prove the input pipeline + `useInput` work in this build — so a *static* screen is either display-only (no list cursor → fine) or a genuine staleness bug. Confirm per screen (not a verdict driver):");
  L.push("");
  const moved = rows.filter((r) => INTERACT.has(r.id) && r.interact.startsWith("frame updated"));
  const staticR = rows.filter((r) => INTERACT.has(r.id) && r.interact.startsWith("no frame change"));
  const crashed = rows.filter((r) => INTERACT.has(r.id) && r.interact.startsWith("CRASH"));
  L.push(`- ✅ **responds to cursor** (${moved.length}): ${moved.map((r) => r.id).join(", ") || "—"}`);
  L.push(`- ⚠ **static — review** (${staticR.length}): ${staticR.map((r) => `${r.id} (${r.owner})`).join(", ") || "—"}`);
  L.push(`- ❌ **crash on input** (${crashed.length}): ${crashed.map((r) => r.id).join(", ") || "none"}`);
  L.push("");
  L.push("_MOD lines (render proof, live values):_");
  L.push("");
  for (const r of rows) L.push(`- \`${r.id}\` — ${r.mod || "(no MOD line)"}`);
  L.push("");

  const report = L.join("\n");
  console.log("\n" + report);
  try {
    writeFileSync(REPORT_PATH, report);
    console.error(`\n(report written to ${REPORT_PATH})`);
  } catch {
    /* stdout is source of truth */
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("harness fatal:", e);
  process.exit(1);
});
