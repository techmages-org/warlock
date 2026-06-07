// Agent data-layer + real-loop tests.
//
// NO live LLM: the loop is driven by PI's built-in FAUX provider with canned
// responses, so we exercise the *actual* @earendil-works/pi-agent-core Agent —
// provider dispatch, tool-schema validation, tool execution against the api
// client, and final-answer extraction — without any network.

import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "../lib/api.js";
import {
  buildModel,
  createAgentRunner,
  createReadOnlyTools,
  missingConfig,
  parseAgentConfig,
  READ_ENDPOINTS,
  SYSTEM_PROMPT,
} from "../lib/agent.js";

// A mock api client that records every GET path and FAILS on any POST — which
// doubles as a guard that the read-only agent never mutates anything.
function mockApi(responses: Record<string, unknown> = {}): { api: ApiClient; gets: string[] } {
  const gets: string[] = [];
  const api: ApiClient = {
    baseUrl: "http://deck:7777",
    async get<T>(path: string): Promise<T> {
      gets.push(path);
      return (responses[path] ?? { ok: true, path }) as T;
    },
    async post<T>(): Promise<T> {
      throw new Error("a READ-ONLY agent must never POST");
    },
  };
  return { api, gets };
}

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
    // The faux tests dispatch to their own provider; this guards the real path
    // streamSimple takes for a live key — the classic "no provider for api …" crash.
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
  it("every tool is GET-only, parameterless, and maps to a known read endpoint", () => {
    const { api } = mockApi();
    const tools = createReadOnlyTools(api);
    expect(tools).toHaveLength(READ_ENDPOINTS.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(typeof t.description).toBe("string");
      // empty object schema => nothing for the model to fill in
      expect((t.parameters as { type?: string }).type).toBe("object");
    }
  });

  it("a tool's execute issues the right GET and returns the live JSON", async () => {
    const { api, gets } = mockApi({ "/api/dashboard/status": { cpu: { percent: 12 }, engagement: { mode: "off" } } });
    const tools = createReadOnlyTools(api);
    const dash = tools.find((t) => t.name === "dashboard_status");
    expect(dash).toBeDefined();
    const result = await dash!.execute("call-1", {});
    expect(gets).toEqual(["/api/dashboard/status"]);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("\"percent\":12");
    expect(result.details).toMatchObject({ cpu: { percent: 12 } });
  });

  it("includes the Phase-1 guidance tools, each on its expected GET path", async () => {
    const { api, gets } = mockApi();
    const tools = createReadOnlyTools(api);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const expected: Record<string, string> = {
      modules_list: "/api/modules",
      crack_status: "/api/crack/status",
      server_audit_status: "/api/server_audit/status",
      sdr_presets: "/api/sdr/presets",
      rtl433_events: "/api/sdr/rtl433/events?n=20",
    };
    for (const [name, path] of Object.entries(expected)) {
      expect(byName[name], `tool ${name} should exist`).toBeDefined();
      await byName[name]!.execute("c", {});
      expect(gets).toContain(path);
    }
  });
});

describe("SYSTEM_PROMPT operator manual", () => {
  it("teaches the chord nav + the read-only/no-action rule", () => {
    expect(SYSTEM_PROMPT).toMatch(/READ-ONLY/);
    expect(SYSTEM_PROMPT).toMatch(/chord/i);
    expect(SYSTEM_PROMPT).toMatch(/never take actions/i);
  });

  it("maps the key screens to their exact g-keys", () => {
    expect(SYSTEM_PROMPT).toContain("g e"); // Operations
    expect(SYSTEM_PROMPT).toContain("g f"); // Wireless flow
    expect(SYSTEM_PROMPT).toContain("g c"); // Crack
    expect(SYSTEM_PROMPT).toContain("g b"); // Assistant (this screen)
  });

  it("covers the engagement lifecycle gate, the wireless flow, and a getting-started playbook", () => {
    expect(SYSTEM_PROMPT).toMatch(/engagement/i);
    expect(SYSTEM_PROMPT).toMatch(/killswitch/i);
    expect(SYSTEM_PROMPT).toMatch(/scope/i);
    expect(SYSTEM_PROMPT).toMatch(/ARM|RECON|LOOT/);
    expect(SYSTEM_PROMPT).toMatch(/getting.started/i);
  });
});

describe("real agent loop (faux provider)", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it("answers a plain question with no tool call", async () => {
    const faux = registerFauxProvider({
      api: "faux-warlock",
      provider: "faux",
      models: [{ id: "faux-1" }],
    });
    unregister = faux.unregister;
    faux.setResponses([fauxAssistantMessage("The deck is nominal.", { stopReason: "stop" })]);

    const { api, gets } = mockApi();
    const runner = createAgentRunner({ api, model: faux.getModel() });
    const answer = await runner.ask("How is the deck?");

    expect(answer).toBe("The deck is nominal.");
    expect(gets).toEqual([]); // no tool needed → no API hit
  });

  it("calls a read-only tool, feeds the result back, and returns the grounded answer", async () => {
    const faux = registerFauxProvider({
      api: "faux-warlock",
      provider: "faux",
      models: [{ id: "faux-1" }],
    });
    unregister = faux.unregister;
    // Turn 1: model asks for dashboard_status. Turn 2: model answers from it.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dashboard_status", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("CPU is at 12% and no engagement is active.", { stopReason: "stop" }),
    ]);

    const { api, gets } = mockApi({
      "/api/dashboard/status": { cpu: { percent: 12 }, engagement: { mode: "off" } },
    });

    const toolCalls: string[] = [];
    const runner = createAgentRunner({ api, model: faux.getModel() });
    const answer = await runner.ask("What's the deck status?", {
      onToolCall: (n) => toolCalls.push(n),
    });

    expect(gets).toEqual(["/api/dashboard/status"]);
    expect(toolCalls).toEqual(["dashboard_status"]);
    expect(answer).toBe("CPU is at 12% and no engagement is active.");
  });
});
