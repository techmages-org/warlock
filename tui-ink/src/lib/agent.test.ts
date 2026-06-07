// Agent data-layer + real-loop tests (Phase-3: gate-aware action tools).
//
// NO live LLM: the loop is driven by PI's built-in FAUX provider with canned
// responses, so we exercise the *actual* @earendil-works/pi-agent-core Agent —
// provider dispatch, tool-schema validation, tool execution against the api
// client, and final-answer extraction — without any network.
//
// CORE SAFETY PROPERTY (this file proves it): the agent may now POST, but the
// BACKEND ENGAGEMENT GATE is the sole guardrail. We replace the old "post throws
// = read-only" mock with a FAUX BACKEND that ENFORCES the gate exactly like the
// real server: engagement-off OR out-of-scope → 403; in-scope → success. The
// tests then prove (a) a refused action is surfaced as a REFUSED result with NO
// fabricated success and NO retry, (b) an in-scope action succeeds, (c) read
// tools still work, and (d) — structurally — every action routes through
// api.post to its gated endpoint, so there is no bypass code path.

import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../lib/api.js";
import {
  ACTION_ENDPOINTS,
  buildModel,
  createActionTools,
  createAgentRunner,
  createAgentTools,
  createReadOnlyTools,
  guidedSetupTool,
  isActionToolName,
  missingConfig,
  parseAgentConfig,
  READ_ENDPOINTS,
  SYSTEM_PROMPT,
} from "../lib/agent.js";

// --------------------------------------------------------------------------- //
// FAUX BACKEND — GETs return canned/live-shaped data; POSTs ENFORCE the
// engagement gate the way the real FastAPI does. The shared api client throws
// `"<status> <statusText> — <path>"` on a non-2xx, so our fake throws the same
// shape on a refusal (403) — that is exactly what the action tool sees in prod.
// --------------------------------------------------------------------------- //

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

interface FakeScope {
  ssids: string[];
  bssids: string[];
  ip_ranges: string[];
}
interface FakeBackend {
  api: ApiClient;
  gets: string[];
  posts: { path: string; body: unknown }[];
  /** number of gated jobs the backend actually issued — MUST stay 0 while refused. */
  jobsIssued: number;
  state: { active: boolean; scope: FakeScope };
}

const UNGATED_RECON = new Set(["/api/wifi_recon/start", "/api/wifi_recon/stop", "/api/net_recon/arpscan"]);
// engagement-active gate, no per-target scope check (karma is promiscuous).
const ENGAGEMENT_ONLY = new Set(["/api/wifi_offensive/karma"]);
// engagement + scope-on-target gate (target optional → engagement-only when absent,
// mirroring the real backend's runner.submit(requires_engagement, target=…)).
const SCOPE_GATED: Record<string, (b: Record<string, unknown>) => string | string[] | undefined> = {
  "/api/wifi_offensive/deauth": (b) => b.bssid as string,
  "/api/wifi_offensive/handshake": (b) => b.bssid as string,
  "/api/wifi_offensive/pmkid": (b) => b.bssid as string,
  "/api/wifi_offensive/evil_twin": (b) => b.ssid as string,
  "/api/wifi_offensive/wps": (b) => b.bssid as string,
  "/api/crack/jobs": (b) => b.target as string | undefined,
  "/api/net_recon/portscan": (b) => b.targets as string[],
  "/api/sdr_offensive/capture": (b) => b.target as string | undefined,
  "/api/sdr_offensive/replay": (b) => b.target as string,
};

function httpErr(status: number, path: string): Error {
  const text = status === 403 ? "Forbidden" : status === 409 ? "Conflict" : status === 404 ? "Not Found" : "Error";
  return new Error(`${status} ${text} — ${path}`);
}

function fakeBackend(opts: { responses?: Record<string, unknown>; active?: boolean; scope?: Partial<FakeScope> } = {}): FakeBackend {
  const responses = opts.responses ?? {};
  const state = {
    active: !!opts.active,
    scope: { ssids: [], bssids: [], ip_ranges: [], ...opts.scope } as FakeScope,
  };
  const self: FakeBackend = { api: undefined as unknown as ApiClient, gets: [], posts: [], jobsIssued: 0, state };

  const classify = (t: string): keyof FakeScope =>
    MAC_RE.test(t) ? "bssids" : /\d+\.\d+/.test(t) || t.includes("/") ? "ip_ranges" : "ssids";
  const addScope = (t: string) => {
    const k = classify(t);
    if (!state.scope[k].some((x) => x.toLowerCase() === t.toLowerCase())) state.scope[k].push(t);
  };
  const inScope = (t: string): boolean => {
    const lo = t.toLowerCase();
    return (["ssids", "bssids", "ip_ranges"] as (keyof FakeScope)[]).some((k) =>
      state.scope[k].some((x) => x.toLowerCase() === lo),
    );
  };
  const requireEngagement = (path: string) => {
    if (!state.active) throw httpErr(403, path);
  };
  const issueJob = () => {
    self.jobsIssued += 1;
    return { ok: true, job_id: `job-${self.jobsIssued}` };
  };

  self.api = {
    baseUrl: "http://deck:7777",
    async get<T>(path: string): Promise<T> {
      self.gets.push(path);
      if (path === "/api/engagements/active") {
        return {
          mode: state.active ? "on" : "off",
          engagement_id: state.active ? "eng-1" : null,
          name: state.active ? "test-eng" : null,
          scope: state.scope,
          started_at: null,
        } as T;
      }
      if (path in responses) return responses[path] as T;
      if (path === "/api/wifi_recon/status") return { ok: true, running: false } as T;
      if (path === "/api/wifi_recon/aps") return { ok: true, aps: [] } as T;
      return { ok: true, path } as T;
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      self.posts.push({ path, body });
      const b = (body ?? {}) as Record<string, unknown>;

      // ---- control (ungated; arming establishes the gate) ----
      if (path === "/api/ops/engagements") {
        state.active = true;
        for (const t of (b.targets as string[]) ?? []) addScope(t);
        return { ok: true, engagement_id: "eng-1", status: { mode: "on" } } as T;
      }
      if (path === "/api/ops/engagements/end") {
        state.active = false;
        return { ok: true } as T;
      }
      if (path === "/api/ops/engagements/scope/add") {
        if (!state.active) throw httpErr(409, path);
        for (const t of (b.targets as string[]) ?? []) addScope(t);
        return { ok: true, scope: state.scope } as T;
      }
      if (path === "/api/engagements/killswitch") {
        state.active = false;
        return { ok: true, cancelled: {} } as T;
      }

      // ---- ungated recon / analysis ----
      if (UNGATED_RECON.has(path)) return { ok: true } as T;
      if (path === "/api/sdr_offensive/analyze") return { ok: true, analysis: {} } as T;

      // ---- server audit: remote types gated on target; lynis ungated ----
      if (path === "/api/server_audit/run") {
        if (b.type !== "lynis") {
          requireEngagement(path);
          const tgt = (b.target as string) || "";
          if (tgt && !inScope(tgt)) throw httpErr(403, path);
        }
        return issueJob() as T;
      }

      // ---- engagement-only gated (no per-target scope) ----
      if (ENGAGEMENT_ONLY.has(path)) {
        requireEngagement(path);
        return issueJob() as T;
      }

      // ---- scope-gated offensive ops ----
      if (path in SCOPE_GATED) {
        requireEngagement(path);
        const raw = SCOPE_GATED[path](b);
        const targets = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const t of targets) if (!inScope(t)) throw httpErr(403, path);
        return issueJob() as T;
      }

      return { ok: true, path } as T;
    },
  };
  return self;
}

// --------------------------------------------------------------------------- //

describe("parseAgentConfig", () => {
  it("reads provider/baseUrl/model/key from env and strips trailing slash", () => {
    const cfg = parseAgentConfig({
      WARLOCK_AGENT_PROVIDER: "minimax",
      WARLOCK_AGENT_BASE_URL: "https://api.minimaxi.chat/v1/",
      WARLOCK_AGENT_MODEL: "MiniMax-Text-01",
      WARLOCK_AGENT_API_KEY: "sk-test",
      WARLOCK_AGENT_MAX_TOKENS: "2048",
    });
    expect(cfg.provider).toBe("minimax");
    expect(cfg.baseUrl).toBe("https://api.minimaxi.chat/v1");
    expect(cfg.model).toBe("MiniMax-Text-01");
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.maxTokens).toBe(2048);
  });

  it("defaults provider to zai and uses sane numeric fallbacks", () => {
    const cfg = parseAgentConfig({});
    expect(cfg.provider).toBe("zai");
    expect(cfg.maxTokens).toBe(1024);
    expect(cfg.contextWindow).toBe(128_000);
  });

  it("missingConfig lists the unset required vars", () => {
    expect(missingConfig(parseAgentConfig({}))).toEqual([
      "WARLOCK_AGENT_BASE_URL",
      "WARLOCK_AGENT_MODEL",
      "WARLOCK_AGENT_API_KEY",
    ]);
    const full = parseAgentConfig({
      WARLOCK_AGENT_BASE_URL: "https://x/v1",
      WARLOCK_AGENT_MODEL: "glm-4.6",
      WARLOCK_AGENT_API_KEY: "k",
    });
    expect(missingConfig(full)).toEqual([]);
  });
});

describe("live provider dispatch", () => {
  it("registers the openai-completions provider on import (the GLM/MiniMax path)", () => {
    expect(getApiProvider("openai-completions")).toBeDefined();
  });
});

describe("buildModel", () => {
  it("produces an openai-completions model from config", () => {
    const m = buildModel(parseAgentConfig({
      WARLOCK_AGENT_PROVIDER: "zai",
      WARLOCK_AGENT_BASE_URL: "https://api.z.ai/api/paas/v4",
      WARLOCK_AGENT_MODEL: "glm-4.6",
      WARLOCK_AGENT_API_KEY: "k",
    }));
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("zai");
    expect(m.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(m.id).toBe("glm-4.6");
  });
});

describe("read-only tools", () => {
  it("every read tool is GET-only, parameterless, and maps to a known read endpoint", () => {
    const { api } = fakeBackend();
    const tools = createReadOnlyTools(api);
    expect(tools).toHaveLength(READ_ENDPOINTS.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(typeof t.description).toBe("string");
      expect((t.parameters as { type?: string }).type).toBe("object");
      // a read tool is NEVER classified as an action tool
      expect(isActionToolName(t.name)).toBe(false);
    }
  });

  it("a read tool's execute issues the right GET and returns the live JSON", async () => {
    const { api, gets } = fakeBackend({ responses: { "/api/dashboard/status": { cpu: { percent: 12 }, engagement: { mode: "off" } } } });
    const tools = createReadOnlyTools(api);
    const dash = tools.find((t) => t.name === "dashboard_status");
    expect(dash).toBeDefined();
    const result = await dash!.execute("call-1", {});
    expect(gets).toEqual(["/api/dashboard/status"]);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("\"percent\":12");
    expect(result.details).toMatchObject({ cpu: { percent: 12 } });
  });
});

describe("action tools — shape + classification", () => {
  it("createActionTools builds one tool per ACTION_ENDPOINT, each an action + POST-only", () => {
    const { api } = fakeBackend();
    const tools = createActionTools(api);
    expect(tools).toHaveLength(ACTION_ENDPOINTS.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect((t.parameters as { type?: string }).type).toBe("object");
      expect(isActionToolName(t.name)).toBe(true);
    }
  });

  it("createAgentTools = read + action + the guided-setup tool", () => {
    const { api } = fakeBackend();
    const all = createAgentTools(api);
    const names = new Set(all.map((t) => t.name));
    expect(all).toHaveLength(READ_ENDPOINTS.length + ACTION_ENDPOINTS.length + 1);
    expect(names.has("guided_engagement_setup")).toBe(true);
    expect(names.has("killswitch")).toBe(true);
    expect(names.has("engagement_create")).toBe(true);
  });

  it("every action endpoint targets a /api/ POST path the UI already calls", () => {
    for (const ep of ACTION_ENDPOINTS) {
      expect(ep.path).toMatch(/^\/api\//);
    }
  });
});

// =========================================================================== //
// CORE SAFETY: the engagement gate is the sole guardrail. INVARIANT — with no
// engagement (or an out-of-scope target) NO gated action ever returns success;
// the tool surfaces a REFUSED result and the backend issues ZERO jobs. Every
// action routes through api.post to its gated endpoint — there is no bypass.
// =========================================================================== //

const OFFENSIVE_TOOLS = ["wifi_deauth", "wifi_handshake", "wifi_pmkid", "wifi_evil_twin", "wifi_karma", "wifi_wps"] as const;

// Minimal valid params per offensive tool (schema-required fields present).
const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  wifi_deauth: { bssid: "AA:BB:CC:DD:EE:01" },
  wifi_handshake: { bssid: "AA:BB:CC:DD:EE:01", channel: 6 },
  wifi_pmkid: { bssid: "AA:BB:CC:DD:EE:01" },
  wifi_evil_twin: { ssid: "CorpNet" },
  wifi_karma: { channel: 1 },
  wifi_wps: { bssid: "AA:BB:CC:DD:EE:01", channel: 6 },
};

describe("engagement gate (core safety property)", () => {
  it("NO active engagement → deauth is REFUSED, no success fabricated, no job issued", async () => {
    const be = fakeBackend({ active: false });
    const deauth = createActionTools(be.api).find((t) => t.name === "wifi_deauth")!;
    const res = await deauth.execute("c", { bssid: "AA:BB:CC:DD:EE:01" });

    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/REFUSED/);
    expect(text).toContain("403");
    expect(res.details).toMatchObject({ ok: false, refused: true, status: 403 });
    // never fabricates a job / ok:true
    expect(JSON.stringify(res)).not.toContain("job_id");
    expect(be.jobsIssued).toBe(0);
    // exactly one POST to the gated endpoint — no internal retry, no bypass call
    expect(be.posts.map((p) => p.path)).toEqual(["/api/wifi_offensive/deauth"]);
  });

  it("INVARIANT — with engagement OFF, every offensive op is refused and issues ZERO jobs", async () => {
    const be = fakeBackend({ active: false });
    const tools = createActionTools(be.api);
    for (const name of OFFENSIVE_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      const res = await t.execute("c", SAMPLE_PARAMS[name]);
      expect(res.details, `${name} must be refused`).toMatchObject({ ok: false, refused: true });
    }
    expect(be.jobsIssued).toBe(0); // the gate let nothing through
  });

  it("active engagement but OUT-OF-SCOPE target → refused (scope is enforced, not just on/off)", async () => {
    const be = fakeBackend({ active: true, scope: { bssids: ["AA:BB:CC:DD:EE:01"] } });
    const deauth = createActionTools(be.api).find((t) => t.name === "wifi_deauth")!;
    const res = await deauth.execute("c", { bssid: "AA:BB:CC:DD:EE:99" }); // not in scope
    expect(res.details).toMatchObject({ ok: false, refused: true, status: 403 });
    expect(be.jobsIssued).toBe(0);
  });

  it("active + IN-SCOPE target → action SUCCEEDS with the real job id", async () => {
    const be = fakeBackend({ active: true, scope: { bssids: ["AA:BB:CC:DD:EE:01"] } });
    const deauth = createActionTools(be.api).find((t) => t.name === "wifi_deauth")!;
    const res = await deauth.execute("c", { bssid: "AA:BB:CC:DD:EE:01" });
    expect(res.details).toMatchObject({ ok: true, refused: false });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/OK/);
    expect(text).toContain("job-1");
    expect(be.jobsIssued).toBe(1);
  });

  it("arming via engagement_create unlocks an in-scope op end-to-end (tool level)", async () => {
    const be = fakeBackend({ active: false });
    const tools = createActionTools(be.api);
    const create = tools.find((t) => t.name === "engagement_create")!;
    const deauth = tools.find((t) => t.name === "wifi_deauth")!;

    // before arming → refused
    expect((await deauth.execute("c", { bssid: "AA:BB:CC:DD:EE:01" })).details).toMatchObject({ refused: true });

    await create.execute("c", { name: "eng", authorization: "client letter", targets: ["AA:BB:CC:DD:EE:01"] });
    expect(be.state.active).toBe(true);

    // after arming with that BSSID in scope → succeeds
    const ok = await deauth.execute("c", { bssid: "AA:BB:CC:DD:EE:01" });
    expect(ok.details).toMatchObject({ ok: true, refused: false });
  });

  it("killswitch is always reachable and disarms the engagement", async () => {
    const be = fakeBackend({ active: true, scope: { bssids: ["AA:BB:CC:DD:EE:01"] } });
    const tools = createActionTools(be.api);
    const kill = tools.find((t) => t.name === "killswitch")!;
    const res = await kill.execute("c", {});
    expect(res.details).toMatchObject({ ok: true });
    expect(be.state.active).toBe(false);
    // and now a previously in-scope op is refused again
    const deauth = tools.find((t) => t.name === "wifi_deauth")!;
    expect((await deauth.execute("c", { bssid: "AA:BB:CC:DD:EE:01" })).details).toMatchObject({ refused: true });
  });

  it("a non-gate failure (e.g. 404 from an unlanded endpoint) is reported as ACTION FAILED, not refused, never fabricated", async () => {
    // The be-lane sdr_offensive endpoints may not exist yet → a real call would
    // 404. Assert that path is reported as a failure (not a 403 refusal, not a
    // success). An inline client that always 404s the capture path.
    const api: ApiClient = {
      baseUrl: "http://deck:7777",
      async get<T>() {
        return {} as T;
      },
      async post<T>(path: string): Promise<T> {
        throw new Error(`404 Not Found — ${path}`);
      },
    };
    const capture = createActionTools(api).find((t) => t.name === "sdr_capture")!;
    const res = await capture.execute("c", { freq_mhz: 433.92 });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/ACTION FAILED/);
    expect(res.details).toMatchObject({ ok: false, refused: false, status: 404 });
  });
});

describe("guided_engagement_setup tool", () => {
  it("reports unarmed state + the fields to collect when no engagement is active", async () => {
    const be = fakeBackend({ active: false });
    const res = await guidedSetupTool(be.api).execute("c", {});
    const d = res.details as { armed: boolean; required_fields_to_arm: string[]; next_step: string };
    expect(d.armed).toBe(false);
    expect(d.required_fields_to_arm.length).toBeGreaterThan(0);
    expect(d.next_step).toMatch(/engagement_create/);
    expect(be.gets).toContain("/api/engagements/active");
  });

  it("reports armed state with nothing left to collect once an engagement is active", async () => {
    const be = fakeBackend({ active: true, scope: { bssids: ["AA:BB:CC:DD:EE:01"] } });
    const res = await guidedSetupTool(be.api).execute("c", {});
    const d = res.details as { armed: boolean; required_fields_to_arm: string[] };
    expect(d.armed).toBe(true);
    expect(d.required_fields_to_arm).toEqual([]);
  });
});

describe("SYSTEM_PROMPT action doctrine", () => {
  it("teaches the chord nav and that the agent now operates tools (not read-only)", () => {
    expect(SYSTEM_PROMPT).toMatch(/chord/i);
    expect(SYSTEM_PROMPT).toMatch(/ACTION DOCTRINE/);
    expect(SYSTEM_PROMPT).toMatch(/autonomous/i);
  });

  it("makes the backend gate the sole guardrail and forbids working around a refusal", () => {
    expect(SYSTEM_PROMPT).toMatch(/engagement gate/i);
    expect(SYSTEM_PROMPT).toMatch(/scope/i);
    expect(SYSTEM_PROMPT).toMatch(/killswitch/i);
    expect(SYSTEM_PROMPT).toMatch(/403/);
    // the non-obvious circumvention path: never self-arm to unblock a refused op
    expect(SYSTEM_PROMPT).toMatch(/self-arm/i);
    expect(SYSTEM_PROMPT).toMatch(/never .*(bypass|work around|circumvent|fabricate)/i);
    expect(SYSTEM_PROMPT).toMatch(/narrate/i);
  });

  it("maps the key screens to their exact g-keys and teaches the guided setup", () => {
    expect(SYSTEM_PROMPT).toContain("g e"); // Operations
    expect(SYSTEM_PROMPT).toContain("g f"); // Wireless flow
    expect(SYSTEM_PROMPT).toContain("g c"); // Crack
    expect(SYSTEM_PROMPT).toContain("g b"); // Assistant (this screen)
    expect(SYSTEM_PROMPT).toMatch(/GUIDED ENGAGEMENT SETUP/);
    expect(SYSTEM_PROMPT).toMatch(/ARM|RECON|LOOT/);
    expect(SYSTEM_PROMPT).toMatch(/authoriz/i);
  });

  it("teaches the SDR replay target-in-scope rule (RF replay needs an authorised in-scope target)", () => {
    // (B): RF replay HARD-gates on a non-empty in-scope target; RF freqs aren't
    // SSIDs/BSSIDs/IPs, so the operator must add an authorising target to scope.
    expect(SYSTEM_PROMPT).toMatch(/sdr_replay/);
    expect(SYSTEM_PROMPT).toMatch(/replay[\s\S]*?(in-scope|scope)[\s\S]*?target|target[\s\S]*?scope/i);
    expect(SYSTEM_PROMPT).toMatch(/engagement_add_scope/);
  });
});

// =========================================================================== //
// REAL AGENT LOOP (faux provider). Drives the actual PI Agent over our tools.
// =========================================================================== //

describe("real agent loop (faux provider)", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  function faux() {
    const f = registerFauxProvider({ api: "faux-warlock", provider: "faux", models: [{ id: "faux-1" }] });
    unregister = f.unregister;
    return f;
  }

  it("answers a plain question with no tool call", async () => {
    const f = faux();
    f.setResponses([fauxAssistantMessage("The deck is nominal.", { stopReason: "stop" })]);
    const be = fakeBackend();
    const runner = createAgentRunner({ api: be.api, model: f.getModel() });
    const answer = await runner.ask("How is the deck?");
    expect(answer).toBe("The deck is nominal.");
    expect(be.gets).toEqual([]);
    expect(be.posts).toEqual([]);
  });

  it("calls a read-only tool, feeds the result back, and returns the grounded answer", async () => {
    const f = faux();
    f.setResponses([
      fauxAssistantMessage(fauxToolCall("dashboard_status", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("CPU is at 12% and no engagement is active.", { stopReason: "stop" }),
    ]);
    const be = fakeBackend({ responses: { "/api/dashboard/status": { cpu: { percent: 12 }, engagement: { mode: "off" } } } });
    const toolCalls: string[] = [];
    const runner = createAgentRunner({ api: be.api, model: f.getModel() });
    const answer = await runner.ask("What's the deck status?", { onToolCall: (n) => toolCalls.push(n) });
    expect(be.gets).toEqual(["/api/dashboard/status"]);
    expect(toolCalls).toEqual(["dashboard_status"]);
    expect(answer).toBe("CPU is at 12% and no engagement is active.");
  });

  it("refused action (no engagement) is reported, called once, and NOT worked around by self-arming", async () => {
    const f = faux();
    // turn 1: try the deauth. turn 2 (after seeing the REFUSED tool result): report + stop.
    f.setResponses([
      fauxAssistantMessage(fauxToolCall("wifi_deauth", { bssid: "AA:BB:CC:DD:EE:01" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("I can't run that — the engagement gate refused it (403). No engagement is active. Want me to walk you through arming one?", { stopReason: "stop" }),
    ]);
    const be = fakeBackend({ active: false });
    const tools: string[] = [];
    const runner = createAgentRunner({ api: be.api, model: f.getModel() });
    const answer = await runner.ask("deauth that AP", { onToolCall: (n) => tools.push(n) });

    expect(tools).toEqual(["wifi_deauth"]);
    // the gated endpoint was hit exactly once (no internal retry)
    expect(be.posts.map((p) => p.path)).toEqual(["/api/wifi_offensive/deauth"]);
    // the agent did NOT self-arm an engagement to bypass the refusal
    expect(be.posts.some((p) => p.path === "/api/ops/engagements")).toBe(false);
    expect(be.jobsIssued).toBe(0);
    expect(answer).toMatch(/refused|403|gate/i);
  });

  it("guided arm → in-scope op succeeds end-to-end through the real loop", async () => {
    const f = faux();
    f.setResponses([
      fauxAssistantMessage(
        fauxToolCall("engagement_create", { name: "ACME", authorization: "signed SOW", targets: ["AA:BB:CC:DD:EE:01"] }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("wifi_deauth", { bssid: "AA:BB:CC:DD:EE:01" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Engagement armed and the deauth job (job-1) is queued against the in-scope AP.", { stopReason: "stop" }),
    ]);
    const be = fakeBackend({ active: false });
    const tools: string[] = [];
    const runner = createAgentRunner({ api: be.api, model: f.getModel() });
    const answer = await runner.ask("arm an engagement for AA:BB:CC:DD:EE:01 then deauth it", { onToolCall: (n) => tools.push(n) });

    expect(tools).toEqual(["engagement_create", "wifi_deauth"]);
    expect(be.posts.map((p) => p.path)).toEqual(["/api/ops/engagements", "/api/wifi_offensive/deauth"]);
    expect(be.state.active).toBe(true);
    expect(be.jobsIssued).toBe(1);
    expect(answer).toMatch(/job-1|armed|queued/i);
  });
});
