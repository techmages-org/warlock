// ============================================================================
// WaRL0c AGENT — on-device pentest ASSISTANT wiring (PI ai + agent-core).
//
// The agent LOGIC runs here in the TUI's Node process; LLM inference is a
// remote, OpenAI-compatible provider (GLM 5.1 / MiniMax / …) reached through
// PI's `@earendil-works/pi-ai`. The tool-calling loop is PI's
// `@earendil-works/pi-agent-core` `Agent`.
//
// We deliberately use the low-level `Agent` (NOT `AgentHarness`): the harness
// requires a filesystem+shell `ExecutionEnv` and a session store, which a
// READ-ONLY assistant has no business holding. `Agent` needs neither.
//
// SAFETY (load-bearing): every tool below is a thin wrapper over a GET on the
// existing Warlock FastAPI. There is NO mutating tool — no scan-start, deauth,
// scope-mutate, killswitch or any POST. The model can only OBSERVE live deck
// state and must ground every answer in real tool output.
//
// PROVIDER CONFIG is read from env at runtime (NEVER hardcode a key):
//   WARLOCK_AGENT_PROVIDER   provider id (e.g. "zai", "minimax"); default "zai"
//   WARLOCK_AGENT_BASE_URL   OpenAI-compatible base URL (required for live use)
//   WARLOCK_AGENT_MODEL      model id (e.g. "glm-4.6", "MiniMax-Text-01")
//   WARLOCK_AGENT_API_KEY    bearer key (required for live use; never committed)
//   WARLOCK_AGENT_MAX_TOKENS optional answer cap (default 1024)
// ============================================================================

import {
  type Message,
  type Model,
  type Static,
  streamSimple,
  type TSchema,
  Type,
} from "@earendil-works/pi-ai";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { ApiClient } from "./api.js";

// --------------------------------------------------------------------------- //
// Provider configuration (env → typed config).
// --------------------------------------------------------------------------- //

export interface AgentConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  contextWindow: number;
}

const DEFAULTS = {
  provider: "zai",
  baseUrl: "",
  model: "",
  apiKey: "",
  maxTokens: 1024,
  contextWindow: 128_000,
} as const;

function num(v: string | undefined, fallback: number): number {
  const n = v != null && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Parse the agent provider config from an environment map (defaults to
// process.env). Pure + unit-testable; performs NO network or key validation.
export function parseAgentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  return {
    provider: (env.WARLOCK_AGENT_PROVIDER || DEFAULTS.provider).trim(),
    baseUrl: (env.WARLOCK_AGENT_BASE_URL || DEFAULTS.baseUrl).trim().replace(/\/+$/, ""),
    model: (env.WARLOCK_AGENT_MODEL || DEFAULTS.model).trim(),
    apiKey: (env.WARLOCK_AGENT_API_KEY || DEFAULTS.apiKey).trim(),
    maxTokens: num(env.WARLOCK_AGENT_MAX_TOKENS, DEFAULTS.maxTokens),
    contextWindow: num(env.WARLOCK_AGENT_CONTEXT_WINDOW, DEFAULTS.contextWindow),
  };
}

// Which required env vars are still unset — drives the screen's "configure me"
// banner. The provider has a default, so only base URL / model / key matter.
export function missingConfig(cfg: AgentConfig): string[] {
  const missing: string[] = [];
  if (!cfg.baseUrl) missing.push("WARLOCK_AGENT_BASE_URL");
  if (!cfg.model) missing.push("WARLOCK_AGENT_MODEL");
  if (!cfg.apiKey) missing.push("WARLOCK_AGENT_API_KEY");
  return missing;
}

// Build a PI `Model` for an OpenAI-compatible chat-completions endpoint. GLM
// 5.1 (z.ai) and MiniMax both speak this API; the provider auto-detects
// per-provider quirks from `baseUrl`.
export function buildModel(cfg: AgentConfig): Model<"openai-completions"> {
  return {
    id: cfg.model || "unconfigured",
    name: cfg.model || "unconfigured",
    api: "openai-completions",
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
  };
}

// --------------------------------------------------------------------------- //
// READ-ONLY tools — one per non-mutating FastAPI endpoint the web/TUI screens
// already call. Empty parameter schema = nothing for the model to fill in,
// which keeps the read-only guarantee trivially auditable.
// --------------------------------------------------------------------------- //

const NoArgs = Type.Object({});

interface ReadEndpoint {
  name: string;
  label: string;
  description: string;
  path: string;
}

// Curated, non-mutating endpoint set spanning the contract's named categories:
// status / recon / ops-engagement / sdr / mesh / system. All GET; payloads
// with large lists carry conservative limits so we don't blow model context.
export const READ_ENDPOINTS: ReadEndpoint[] = [
  { name: "dashboard_status", label: "Dashboard", description: "Overall deck health: CPU, temperature, memory, disk, time sync, GPS/mesh/SDR roll-up, and current engagement mode.", path: "/api/dashboard/status" },
  { name: "system_status", label: "System", description: "System host telemetry: CPU, memory, disk, thermals and uptime.", path: "/api/system/status" },
  { name: "modules_list", label: "Modules / nav", description: "The live list of available modules/screens the deck exposes (id, label, gating). Use it to know exactly which screens exist and what is gated before guiding the operator.", path: "/api/modules" },
  { name: "engagement_status", label: "Operations", description: "Operations / engagement status: whether an authorized engagement is active and its scope summary.", path: "/api/ops/status" },
  { name: "active_engagement", label: "Active engagement", description: "The currently active engagement (mode, name, scope) if one is running. Read this first to tailor getting-started guidance.", path: "/api/engagements/active" },
  { name: "wifi_recon_status", label: "Wi-Fi recon status", description: "Wireless recon sweep state: monitor interface, whether airodump is running, and AP/client counts seen.", path: "/api/wifi_recon/status" },
  { name: "wifi_access_points", label: "Access points", description: "Access points discovered by the live Wi-Fi recon sweep (BSSID, ESSID, channel, encryption, signal).", path: "/api/wifi_recon/aps" },
  { name: "wifi_clients", label: "Wi-Fi clients", description: "Client stations observed by the Wi-Fi recon sweep and which AP they are associated with.", path: "/api/wifi_recon/clients" },
  { name: "crack_status", label: "Crack", description: "Password-cracking queue status: hashcat availability, queued/running/cracked job counts, and available hashfiles/wordlists.", path: "/api/crack/status" },
  { name: "wireless_ids_status", label: "Wireless IDS", description: "Wireless intrusion-detection status and recent alert counts (deauth floods, rogue APs, etc.).", path: "/api/wireless_ids/status" },
  { name: "net_recon_status", label: "Network recon", description: "Wired/network reconnaissance status (active scans, interface, host counts).", path: "/api/net_recon/status" },
  { name: "net_recon_hosts", label: "Network hosts", description: "Hosts discovered by network recon (IP, MAC, vendor, open ports). Capped to the first 25.", path: "/api/net_recon/hosts?limit=25" },
  { name: "server_audit_status", label: "Server audit", description: "Server/service audit status: scan availability and recent audit findings against a target host.", path: "/api/server_audit/status" },
  { name: "sdr_status", label: "SDR", description: "Software-defined-radio status: detected dongles and active capture state.", path: "/api/sdr/status" },
  { name: "sdr_presets", label: "SDR presets", description: "Available SDR tuning presets (named frequency/mode profiles the operator can use).", path: "/api/sdr/presets" },
  { name: "adsb_aircraft", label: "ADS-B aircraft", description: "Aircraft currently tracked via ADS-B (callsign, position, altitude, speed).", path: "/api/sdr/adsb/aircraft" },
  { name: "rtl433_events", label: "rtl_433 events", description: "Recent rtl_433 ISM-band sensor/device events decoded by the SDR (last 20).", path: "/api/sdr/rtl433/events?n=20" },
  { name: "mesh_nodes", label: "Mesh", description: "Meshtastic mesh nodes currently visible (node id, name, SNR, last heard, position).", path: "/api/mesh/nodes" },
  { name: "gps_fix", label: "GPS", description: "Current GPS fix: mode, latitude/longitude, satellites and accuracy.", path: "/api/gps/fix" },
];

// Wrap one read endpoint as a PI AgentTool. The handler does a single GET and
// returns the live JSON verbatim. Per PI's contract it THROWS on HTTP failure
// (api.get already throws on non-2xx); the loop converts that into an error
// tool result, so we never fabricate a "success" payload.
function readTool(ep: ReadEndpoint, api: ApiClient): AgentTool<typeof NoArgs> {
  return {
    name: ep.name,
    label: ep.label,
    description: ep.description,
    parameters: NoArgs,
    execute: async (_id: string, _params: Static<typeof NoArgs>) => {
      const data = await api.get<unknown>(ep.path);
      const text = JSON.stringify(data ?? null);
      return { content: [{ type: "text", text }], details: data };
    },
  };
}

export function createReadOnlyTools(api: ApiClient): AgentTool<TSchema>[] {
  return READ_ENDPOINTS.map((ep) => readTool(ep, api) as AgentTool<TSchema>);
}

// --------------------------------------------------------------------------- //
// System prompt — grounds the assistant: read-only, no actions, no invention.
// --------------------------------------------------------------------------- //

export const SYSTEM_PROMPT = [
  "You are WaRL0c, the on-device AI assistant for the Warlock cyberdeck — a portable",
  "Wi-Fi / RF / network reconnaissance & red-team platform. You are an INSTRUCTIONAL",
  "OPERATOR GUIDE: you understand the whole system and walk the operator through using",
  "it, grounded in the deck's live state.",
  "",
  "CORE RULES",
  "- READ-ONLY: you OBSERVE live state via tools and ADVISE. You NEVER take actions —",
  "  no starting scans, sending packets, deauth, changing scope, or the killswitch. For",
  "  any action, tell the operator the exact keys to press; THEY act, not you.",
  "- Ground every answer in real tool output. ALWAYS read the relevant live state before",
  "  answering a question about the deck. Never invent or guess values; if a tool errors",
  "  or returns nothing, say so plainly.",
  "- Be concise and operator-grade, and CITE EXACT KEYS (e.g. \"press g e\").",
  "",
  "NAVIGATION",
  "- Screens are reached with a CHORD: tap `g`, release, then tap the screen's key",
  "  (e.g. g then e → Operations).",
  "- Global keys: `?` help · `q` quit · `Ctrl+K` killswitch (emergency stop). On THIS",
  "  assistant screen those are literal text; press `Esc` to return to the dashboard.",
  "",
  "SCREEN MAP (g-key → screen → purpose)",
  "- g d  Dashboard — overall deck health (CPU/temp/mem/disk, time, GPS/mesh/SDR, engagement).",
  "- g b  Assistant — you (this chat).",
  "- g f  Wireless — guided red-team flow (recon → attack → crack in one screen).",
  "- g w  Wi-Fi Recon — passive AP/client sweep (airodump).",
  "- g o  Wi-Fi Offensive — deauth / handshake / PMKID / evil-twin / WPS (GATED).",
  "- g c  Crack — hashcat queue for captured handshakes / PMKIDs.",
  "- g i  Wireless IDS — detect deauth floods / rogue APs.",
  "- g n  Net Recon — wired/network host + service discovery.",
  "- g a  Server Audit — scan a host's services for issues.",
  "- g s  SDR — software-defined radio status, presets + ADS-B.",
  "- g x  SDR Offensive — RF transmit ops (GATED).",
  "- g g  GPS — fix, satellites, tracks, time.",
  "- g m  Mesh — Meshtastic node list + messaging.",
  "- g e  Operations — engagements: create / activate / scope / end + audit log.",
  "- g h  System — host services, journal, network detail.",
  "- g u  Audio — audio device status.",
  "- g p  ESP32 Companion — companion-board status.",
  "",
  "ENGAGEMENT LIFECYCLE (the gate)",
  "- Offensive / gated ops (Wi-Fi Offensive, SDR Offensive, Crack, the Wireless ACT step)",
  "  require an ACTIVE engagement with the target IN SCOPE.",
  "- Create one on Operations `g e`: a name, the authorization, and REAL targets — actual",
  "  SSIDs / BSSIDs / IP CIDRs you are authorized to test (never placeholder words). It",
  "  then activates.",
  "- You can authorize a freshly-recon'd AP into scope inline: in the Wireless flow press",
  "  `s` on the selected AP.",
  "- End the engagement on Operations when done. `Ctrl+K` is the killswitch — it stops all",
  "  jobs and restores interfaces immediately.",
  "- Authorization is a HUMAN decision — you never create, activate, or scope engagements.",
  "",
  "WIRELESS GUIDED FLOW (g f) — the one-screen chain, steps 1–5:",
  "- 1 ARM:    `←/→` pick channel band · `a` arm (monitor mode + sweep) · `d` disarm.",
  "- 2 RECON:  `↑/↓` select an AP · `Enter` lock it as target · `s` add it to scope.",
  "- 3 TARGET: review the locked AP · `Enter` proceed to ACT.",
  "- 4 ACT:    `↑/↓` choose op (deauth/handshake/PMKID/evil-twin/WPS) · `Enter` fire (GATED).",
  "- 5 LOOT:   `↑/↓` pick a capture · `Enter` send it to Crack (g c).",
  "",
  "GETTING-STARTED PLAYBOOK (tailor to live state — read active_engagement and",
  "wifi_recon_status first, then meet the operator where they actually are):",
  "  1. No active engagement? → g e, create one with real authorized targets.",
  "  2. g f, press `a` to arm recon (monitor + scan).",
  "  3. When APs appear in RECON, select your target and press `s` to scope it (if needed).",
  "  4. Lock it (Enter), go to ACT, run deauth or handshake capture (Enter).",
  "  5. In LOOT, send the capture to Crack (Enter); watch progress on g c.",
  "  Adapt: if an engagement is already active skip step 1; if recon is already running,",
  "  skip straight to picking a target. Always cite the exact keys.",
  "",
  "TOOLS",
  "- You have read-only tools for live state: dashboard, system, the modules/nav list,",
  "  operations & active engagement, Wi-Fi recon (status/APs/clients), crack queue,",
  "  wireless IDS, network recon (status/hosts), server audit, SDR (status/presets/ADS-B/",
  "  rtl_433), mesh, and GPS. Use them to ground and tailor every answer.",
].join("\n");

// --------------------------------------------------------------------------- //
// Runner — a thin, screen-facing facade over a single reusable Agent. The
// screen calls `ask()`; tests inject a fake runner (see agent.test.tsx) or
// drive this real runner with a faux provider (see agent.test.ts).
// --------------------------------------------------------------------------- //

export interface AskOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onToolCall?: (toolName: string) => void;
}

export interface AgentRunner {
  ask(question: string, opts?: AskOptions): Promise<string>;
}

export interface CreateRunnerOptions {
  api: ApiClient;
  config?: AgentConfig;
  /** Override the model (tests use a faux-provider model). */
  model?: Model<"openai-completions"> | Model<string>;
  /** Override the stream function (defaults to PI's `streamSimple`). */
  streamFn?: StreamFn;
  systemPrompt?: string;
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m.role === "assistant") {
      if (typeof m.content === "string") return m.content;
      return m.content
        .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
        .map((c) => c.text)
        .join("");
    }
  }
  return "";
}

// Build the production runner: a single Agent reused across turns (so the chat
// keeps short-term context), backed by PI's streamSimple → OpenAI-compatible
// provider. The provider api key is resolved at call time via getApiKey — it is
// only ever read from config (env), never embedded.
export function createAgentRunner(opts: CreateRunnerOptions): AgentRunner {
  const config = opts.config ?? parseAgentConfig();
  const model = opts.model ?? buildModel(config);
  const streamFn: StreamFn = opts.streamFn ?? (streamSimple as unknown as StreamFn);
  const tools = createReadOnlyTools(opts.api);

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
      model: model as Model<string>,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    streamFn,
    convertToLlm: (messages: AgentMessage[]) => messages as Message[],
    getApiKey: () => (config.apiKey ? config.apiKey : undefined),
  });

  return {
    async ask(question: string, askOpts: AskOptions = {}): Promise<string> {
      const { signal, onDelta, onToolCall } = askOpts;
      let finalText = "";

      const onAbort = () => agent.abort();
      if (signal) {
        if (signal.aborted) agent.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          onToolCall?.(event.toolName);
        } else if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          onDelta?.(event.assistantMessageEvent.delta);
        } else if (event.type === "agent_end") {
          finalText = lastAssistantText(event.messages);
        }
      });

      try {
        await agent.prompt(question);
        await agent.waitForIdle();
      } finally {
        unsubscribe();
        if (signal) signal.removeEventListener("abort", onAbort);
      }

      const err = agent.state.errorMessage;
      if (err && !finalText.trim()) throw new Error(err);
      return finalText.trim();
    },
  };
}
