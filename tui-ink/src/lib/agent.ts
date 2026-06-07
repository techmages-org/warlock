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
// SAFETY (load-bearing): the agent has READ tools (GET) AND ACTION tools (POST).
// Phase-3 decision: the agent fires action tools AUTONOMOUSLY, but the BACKEND
// ENGAGEMENT GATE (scope + audit + killswitch) is the SOLE guardrail. Every
// action tool routes through `api.post` to an EXISTING gated endpoint — the same
// route the web/Ink UI calls — so the server, not the model, authorizes each op.
// There is NO bypass code path. On a 403 (engagement-off / out-of-scope) the tool
// surfaces a model-visible REFUSED result; it never fabricates success, never
// retries, and the system prompt forbids working around a refusal (e.g. self-
// arming an engagement). The killswitch tool is always reachable.
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
// ACTION (write) tools — Phase-3. Each is a thin wrapper over a POST to an
// EXISTING gated FastAPI endpoint (the same routes the web/Ink UI calls). The
// agent fires these autonomously, but the BACKEND ENGAGEMENT GATE (scope +
// audit + killswitch) is the SOLE guardrail: there is NO bypass code path here.
// Every offensive/scoped action routes through `api.post` to its gated endpoint;
// the server decides. On a refusal (HTTP 403 = engagement-off / out-of-scope)
// the tool returns a clear, MODEL-VISIBLE "REFUSED" result — it never fabricates
// a success and never silently retries. The system prompt forbids working around
// a refusal (e.g. self-arming an engagement to unblock a blocked op).
// --------------------------------------------------------------------------- //

/** Classification used for narration + chat display. */
export type ActionKind = "control" | "recon" | "offensive" | "rf" | "crack" | "audit";

export interface ActionEndpoint {
  name: string;
  label: string;
  description: string;
  /** POST path — an existing gated endpoint the UI already calls. */
  path: string;
  /** TypeBox schema the model fills in. */
  parameters: TSchema;
  /** Validated params → request body (undefined → no body). */
  build: (p: Record<string, unknown>) => unknown;
  /** True when the server engagement-gates this op (offensive / scoped). */
  gated: boolean;
  kind: ActionKind;
}

// Drop undefined/null keys so optional params fall back to the backend's own
// Pydantic defaults (we never hardcode a default that could drift from the API).
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const Targets = Type.Array(Type.String(), {
  description: "REAL authorized targets only — actual SSIDs, BSSIDs (AA:BB:CC:DD:EE:FF) and/or IPs/CIDRs. Never placeholders like 'ssid'/'test'/'example'.",
});

// The curated action set. Grouped: engagement/control, recon, offensive Wi-Fi,
// crack, server audit, offensive SDR. Paths verified against the module routers.
export const ACTION_ENDPOINTS: ActionEndpoint[] = [
  // ---- Engagement / control ------------------------------------------------ //
  {
    name: "engagement_create",
    label: "Arm engagement",
    description:
      "ARM an engagement: create AND activate it atomically — this is the gate that authorizes every offensive/scoped op. Targets MUST be REAL authorized SSIDs/BSSIDs/IP-CIDRs the operator named. Refused 400 on empty/placeholder targets, 409 if an engagement is already active. Use ONLY in the guided setup once the operator has given a name, an authorization statement, and real targets — NEVER invent an authorization to unblock a refused op.",
    path: "/api/ops/engagements",
    parameters: Type.Object({
      name: Type.String({ description: "Engagement name, e.g. 'ACME rooftop assessment'." }),
      authorization: Type.String({ description: "The operator's authorization statement (who authorized the test + scope of work). Must be operator-provided — never fabricated." }),
      targets: Targets,
      duration_hours: Type.Optional(Type.Number({ description: "Planned length in hours (default 4)." })),
    }),
    build: (p) => compact({ name: p.name, authorization: p.authorization, targets: p.targets, duration_hours: p.duration_hours }),
    gated: false,
    kind: "control",
  },
  {
    name: "engagement_add_scope",
    label: "Add scope target",
    description:
      "Authorize ADDITIONAL real targets onto the ACTIVE engagement's scope allowlist inline (SSIDs/BSSIDs/IP-CIDRs). 409 if no engagement is active. Real targets only.",
    path: "/api/ops/engagements/scope/add",
    parameters: Type.Object({ targets: Targets }),
    build: (p) => ({ targets: p.targets }),
    gated: false,
    kind: "control",
  },
  {
    name: "engagement_end",
    label: "End engagement",
    description: "End the ACTIVE engagement (stops authorizing gated ops, closes the audit window). 409 if none active.",
    path: "/api/ops/engagements/end",
    parameters: Type.Object({}),
    build: () => undefined,
    gated: false,
    kind: "control",
  },
  {
    name: "killswitch",
    label: "KILLSWITCH",
    description:
      "EMERGENCY STOP — the same Ctrl+K killswitch. Immediately cancels ALL running jobs (recon, offensive, crack, audit) and restores network interfaces. Always available, even with no engagement. Invoke if anything looks wrong or the operator asks to stop everything.",
    path: "/api/engagements/killswitch",
    parameters: Type.Object({}),
    build: () => undefined,
    gated: false,
    kind: "control",
  },
  // ---- Recon (passive = ungated; scoped = gated) --------------------------- //
  {
    name: "wifi_recon_scan",
    label: "Start Wi-Fi recon",
    description:
      "Start the PASSIVE Wi-Fi recon sweep (monitor mode + airodump). No engagement required — passive observation. After it runs, read wifi_access_points / wifi_clients for results.",
    path: "/api/wifi_recon/start",
    parameters: Type.Object({
      channels: Type.Optional(Type.String({ description: "'all' | '2.4' | '5' | comma-list e.g. '1,6,11,36'. Default 'all'." })),
    }),
    build: (p) => compact({ channels: p.channels }),
    gated: false,
    kind: "recon",
  },
  {
    name: "wifi_recon_stop",
    label: "Stop Wi-Fi recon",
    description: "Stop the passive Wi-Fi recon sweep and release the monitor interface.",
    path: "/api/wifi_recon/stop",
    parameters: Type.Object({}),
    build: () => undefined,
    gated: false,
    kind: "recon",
  },
  {
    name: "net_recon_arpscan",
    label: "ARP sweep subnet",
    description:
      "Sweep the deck's OWN local subnet for live hosts (nmap ARP/ICMP). Ungated own-network discovery. After it runs, read network_hosts.",
    path: "/api/net_recon/arpscan",
    parameters: Type.Object({}),
    build: () => undefined,
    gated: false,
    kind: "recon",
  },
  {
    name: "net_recon_portscan",
    label: "Port scan",
    description:
      "nmap port/service scan of one or more targets. ENGAGEMENT-GATED whenever a target is non-RFC1918, a CIDR wider than /24, or the profile is intrusive (vuln/service) — those require an active in-scope engagement (403 otherwise). A 'quick' scan of your own RFC1918 subnet is ungated.",
    path: "/api/net_recon/portscan",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { description: "IPs/hostnames/CIDRs to scan." }),
      profile: Type.Optional(Type.String({ description: "quick | service | vuln (vuln/service are always gated). Default quick." })),
    }),
    build: (p) => compact({ targets: p.targets, profile: p.profile }),
    gated: true,
    kind: "recon",
  },
  // ---- Offensive Wi-Fi (all engagement-gated) ------------------------------ //
  {
    name: "wifi_deauth",
    label: "Deauth",
    description:
      "OFFENSIVE (gated): aireplay-ng deauthentication burst against a target AP (optionally a specific client). REAL RF injection. Requires an ACTIVE engagement with the BSSID in scope — 403 otherwise.",
    path: "/api/wifi_offensive/deauth",
    parameters: Type.Object({
      bssid: Type.String({ description: "Target AP BSSID (must be in engagement scope)." }),
      client: Type.Optional(Type.String({ description: "Optional specific client MAC to deauth." })),
      count: Type.Optional(Type.Number({ description: "Deauth bursts, 0 = continuous. Default 64." })),
      pps: Type.Optional(Type.Number({ description: "Injection rate packets/sec. Default 0." })),
    }),
    build: (p) => compact({ bssid: p.bssid, client: p.client, count: p.count, pps: p.pps }),
    gated: true,
    kind: "offensive",
  },
  {
    name: "wifi_handshake",
    label: "Capture handshake",
    description:
      "OFFENSIVE (gated): force + capture a WPA EAPOL handshake (targeted deauth + airodump). Requires active engagement with the BSSID in scope. Produces a capture you can feed to crack_submit.",
    path: "/api/wifi_offensive/handshake",
    parameters: Type.Object({
      bssid: Type.String({ description: "Target AP BSSID (in scope)." }),
      channel: Type.Number({ description: "AP channel (1-196)." }),
      client: Type.Optional(Type.String({ description: "Optional client MAC for targeted deauth." })),
      duration: Type.Optional(Type.Number({ description: "Capture window seconds. Default 90." })),
      deauth_count: Type.Optional(Type.Number({ description: "Deauth bursts to force EAPOL. Default 5." })),
    }),
    build: (p) => compact({ bssid: p.bssid, channel: p.channel, client: p.client, duration: p.duration, deauth_count: p.deauth_count }),
    gated: true,
    kind: "offensive",
  },
  {
    name: "wifi_pmkid",
    label: "PMKID capture",
    description:
      "OFFENSIVE (gated): clientless PMKID capture (hcxdumptool → .hc22000). Requires active engagement with the BSSID in scope. Can auto-chain a crack.",
    path: "/api/wifi_offensive/pmkid",
    parameters: Type.Object({
      bssid: Type.String({ description: "Target AP BSSID (in scope)." }),
      duration: Type.Optional(Type.Number({ description: "Capture window seconds. Default 60." })),
      auto_crack: Type.Optional(Type.Boolean({ description: "Chain a hashcat crack after conversion. Default false." })),
      wordlist: Type.Optional(Type.String({ description: "Wordlist filename under wordlists/ (for auto_crack)." })),
    }),
    build: (p) => compact({ bssid: p.bssid, duration: p.duration, auto_crack: p.auto_crack, wordlist: p.wordlist }),
    gated: true,
    kind: "offensive",
  },
  {
    name: "wifi_evil_twin",
    label: "Evil twin",
    description:
      "OFFENSIVE (gated): airbase-ng rogue AP cloning a target SSID + captive portal. REAL AP broadcast. Requires active engagement with the SSID in scope.",
    path: "/api/wifi_offensive/evil_twin",
    parameters: Type.Object({
      ssid: Type.String({ description: "Target SSID to clone (must be in scope)." }),
      channel: Type.Optional(Type.Number({ description: "AP channel. Default 1." })),
      duration: Type.Optional(Type.Number({ description: "AP lifetime seconds. Default 900." })),
    }),
    build: (p) => compact({ ssid: p.ssid, channel: p.channel, duration: p.duration }),
    gated: true,
    kind: "offensive",
  },
  {
    name: "wifi_karma",
    label: "Karma/MANA",
    description:
      "OFFENSIVE (gated): promiscuous karma/MANA rogue AP that answers ALL client probe requests (no single target SSID). Gated on engagement-active ONLY (no per-target scope check — it has no target). Requires an ACTIVE engagement (403 if off).",
    path: "/api/wifi_offensive/karma",
    parameters: Type.Object({
      channel: Type.Optional(Type.Number({ description: "AP channel. Default 1." })),
      duration: Type.Optional(Type.Number({ description: "AP lifetime seconds. Default 900." })),
    }),
    build: (p) => compact({ channel: p.channel, duration: p.duration }),
    gated: true,
    kind: "offensive",
  },
  {
    name: "wifi_wps",
    label: "WPS attack",
    description:
      "OFFENSIVE (gated): reaver/bully WPS PIN attack (optionally Pixie-Dust) against a target AP. Requires active engagement with the BSSID in scope.",
    path: "/api/wifi_offensive/wps",
    parameters: Type.Object({
      bssid: Type.String({ description: "Target AP BSSID (in scope)." }),
      channel: Type.Number({ description: "AP channel." }),
      tool: Type.Optional(Type.String({ description: "WPS engine: reaver | bully. Default reaver." })),
      pixie_dust: Type.Optional(Type.Boolean({ description: "Pixie-Dust offline attack. Default false." })),
      duration: Type.Optional(Type.Number({ description: "Attack time budget seconds. Default 600." })),
    }),
    build: (p) => compact({ bssid: p.bssid, channel: p.channel, tool: p.tool, pixie_dust: p.pixie_dust, duration: p.duration }),
    gated: true,
    kind: "offensive",
  },
  // ---- Crack (gated) ------------------------------------------------------- //
  {
    name: "crack_submit",
    label: "Submit crack job",
    description:
      "Queue a hashcat crack of a captured handshake/PMKID (.hc22000 or raw .cap/.pcapng under captures/ or handshakes/). ENGAGEMENT-GATED: requires an active engagement; if you pass a target (BSSID/ESSID) it must be in scope (403 otherwise).",
    path: "/api/crack/jobs",
    parameters: Type.Object({
      hashfile: Type.String({ description: "Path/name of the capture under captures/ or handshakes/." }),
      wordlist: Type.Optional(Type.String({ description: "Wordlist filename under wordlists/ (default rockyou.txt)." })),
      mode: Type.Optional(Type.String({ description: "hashcat -m mode: 22000 (default) or 16800." })),
      target: Type.Optional(Type.String({ description: "BSSID/ESSID the hash belongs to (scope-checked)." })),
    }),
    build: (p) => compact({ hashfile: p.hashfile, wordlist: p.wordlist, mode: p.mode, target: p.target }),
    gated: true,
    kind: "crack",
  },
  // ---- Server audit (remote types gated) ----------------------------------- //
  {
    name: "server_audit_run",
    label: "Run server audit",
    description:
      "Submit a server/service audit. REMOTE types (nmap-vuln, nikto, ssh-config) are ENGAGEMENT-GATED — they require an active engagement with the target in scope (403 otherwise). The LOCAL 'lynis' type audits the deck itself and is ungated.",
    path: "/api/server_audit/run",
    parameters: Type.Object({
      type: Type.String({ description: "Audit type: nmap-vuln | nikto | lynis | ssh-config." }),
      target: Type.Optional(Type.String({ description: "IP/host (nmap/ssh) or URL (nikto); ignored for lynis. In-scope for remote types." })),
      note: Type.Optional(Type.String({ description: "Free-text note for the audit row." })),
      user: Type.Optional(Type.String({ description: "SSH user (ssh-config)." })),
      port: Type.Optional(Type.Number({ description: "SSH port (ssh-config). Default 22." })),
      key: Type.Optional(Type.String({ description: "SSH private-key path (ssh-config)." })),
    }),
    build: (p) => compact({ type: p.type, target: p.target, note: p.note, user: p.user, port: p.port, key: p.key }),
    gated: true,
    kind: "audit",
  },
  // ---- Offensive SDR (be-lane sdr_offensive.py — FROZEN contract) ----------- //
  // Bodies key off freq_mhz (MHz float); capture/replay/analyze accept a capture
  // id|filename (or full path). target authorises the op (scope-checked when set).
  {
    name: "sdr_capture",
    label: "SDR capture",
    description:
      "OFFENSIVE SDR (gated): record an RF signal (IQ) to a file for later analysis/replay (e.g. garage/TPMS/433 MHz remotes). RX only — the deck auto-selects the RX radio. ENGAGEMENT-GATED: requires an active engagement; if you pass a target it must be in scope (403 otherwise).",
    path: "/api/sdr_offensive/capture",
    parameters: Type.Object({
      freq_mhz: Type.Number({ description: "Centre frequency in MEGAHERTZ, e.g. 433.92." }),
      sample_rate: Type.Optional(Type.Number({ description: "Sample rate in samples/sec. Default 2000000." })),
      duration_s: Type.Optional(Type.Number({ description: "Capture window seconds (1-300). Default 5." })),
      target: Type.Optional(Type.String({ description: "In-scope target authorising the capture (scope-checked if given)." })),
    }),
    build: (p) => compact({ freq_mhz: p.freq_mhz, sample_rate: p.sample_rate, duration_s: p.duration_s, target: p.target }),
    gated: true,
    kind: "rf",
  },
  {
    name: "sdr_replay",
    label: "SDR replay (TX)",
    description:
      "OFFENSIVE SDR (HARD-gated, RF-EMITTING): TRANSMIT a previously captured signal (HackRF). This emits on real RF and is audited. Requires an ACTIVE engagement; ALWAYS pass a `target` — the in-scope identifier that authorises the emission (scope-checked; out-of-scope → 403). Confirm the operator's intent before invoking.",
    path: "/api/sdr_offensive/replay",
    parameters: Type.Object({
      capture: Type.String({ description: "Capture id or filename under captures/sdr/ to transmit." }),
      freq_mhz: Type.Number({ description: "TX centre frequency in MEGAHERTZ." }),
      target: Type.String({ description: "In-scope identifier authorising this RF emission (scope-checked). Always provide it." }),
      sample_rate: Type.Optional(Type.Number({ description: "Sample rate in samples/sec. Default 2000000." })),
      tx_gain: Type.Optional(Type.Number({ description: "HackRF TX VGA gain dB (0-47). Default 0." })),
      path: Type.Optional(Type.String({ description: "Full path to the capture under captures/sdr/ (alternative to capture)." })),
    }),
    build: (p) => compact({ capture: p.capture, path: p.path, freq_mhz: p.freq_mhz, target: p.target, sample_rate: p.sample_rate, tx_gain: p.tx_gain }),
    gated: true,
    kind: "rf",
  },
  {
    name: "sdr_analyze",
    label: "SDR analyze",
    description:
      "Summarise a captured RF signal file (sample count, duration, RMS/peak magnitude) offline. Operates on an existing capture — NO transmission, NO gate.",
    path: "/api/sdr_offensive/analyze",
    parameters: Type.Object({
      capture: Type.String({ description: "Capture id or filename under captures/sdr/ to analyse." }),
      path: Type.Optional(Type.String({ description: "Full path to the capture under captures/sdr/ (alternative to capture)." })),
    }),
    build: (p) => compact({ capture: p.capture, path: p.path }),
    gated: false,
    kind: "rf",
  },
];

/** Names of every action (write) tool — used by the chat UI to label tool calls. */
export const ACTION_TOOL_NAMES: ReadonlySet<string> = new Set(ACTION_ENDPOINTS.map((e) => e.name));

/** True if `name` is an action (write) tool rather than a read-only one. */
export function isActionToolName(name: string): boolean {
  return ACTION_TOOL_NAMES.has(name);
}

interface ActionResultDetails {
  ok: boolean;
  refused: boolean;
  status?: number;
  error?: string;
  data?: unknown;
}

// Wrap one action endpoint as a PI AgentTool. CATCH-AND-RETURN (not throw): the
// loop stays alive so the model can NARRATE the outcome — success OR refusal —
// from the model-visible text. We never fabricate success and never retry.
function actionTool(ep: ActionEndpoint, api: ApiClient): AgentTool<TSchema> {
  return {
    name: ep.name,
    label: ep.label,
    description: ep.description,
    parameters: ep.parameters,
    execute: async (_id: string, params: Static<TSchema>) => {
      const body = ep.build((params ?? {}) as Record<string, unknown>);
      try {
        const data = await api.post<unknown>(ep.path, body);
        const details: ActionResultDetails = { ok: true, refused: false, data: data ?? null };
        const text = `OK ${ep.name} → ${ep.path}\n${JSON.stringify(data ?? { ok: true })}`;
        return { content: [{ type: "text", text }], details };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // The shared api client throws `"<status> <statusText> — <path>"`; 403 is
        // the engagement gate (engagement-off OR out-of-scope).
        const status = Number((msg.match(/\b(\d{3})\b/) ?? [])[1]) || undefined;
        const refused = status === 403;
        const details: ActionResultDetails = { ok: false, refused, status, error: msg };
        const text = refused
          ? `REFUSED by the engagement gate (${msg}). The backend blocked ${ep.name}: either no engagement is active, or the target is OUT OF SCOPE. Do NOT retry and do NOT work around the gate (do not self-arm an engagement to unblock it). Explain the refusal to the operator; if they have real authorization, offer to walk them through arming an in-scope engagement.`
          : `ACTION FAILED for ${ep.name} (${msg}). Report this to the operator verbatim — do NOT fabricate success or retry blindly.`;
        return { content: [{ type: "text", text }], details };
      }
    },
  };
}

export function createActionTools(api: ApiClient): AgentTool<TSchema>[] {
  return ACTION_ENDPOINTS.map((ep) => actionTool(ep, api));
}

// --------------------------------------------------------------------------- //
// GUIDED SETUP tool — a single read-only call that snapshots WHERE the operator
// is so the agent can drive the "arm an engagement" conversation instructionally
// (engagement on/off, recon running, visible candidate APs, what to collect, the
// next step). Composes a few GETs; each is independently fault-tolerant so a
// partial snapshot still returns.
// --------------------------------------------------------------------------- //

const REQUIRED_ARM_FIELDS = [
  "name — a label for the engagement",
  "authorization — who authorized the test and its scope (operator-provided, never fabricated)",
  "targets — REAL SSIDs / BSSIDs / IP-CIDRs the operator is authorized to test",
] as const;

async function safeGet<T>(api: ApiClient, path: string): Promise<T | { error: string }> {
  try {
    return await api.get<T>(path);
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function guidedSetupTool(api: ApiClient): AgentTool<TSchema> {
  const tool: AgentTool<typeof NoArgs> = {
    name: "guided_engagement_setup",
    label: "Guided setup",
    description:
      "Snapshot the operator's CURRENT position for guiding them through ARMING an engagement: the active-engagement status (on/off + scope), whether Wi-Fi recon is running, candidate target APs already visible, the fields you still need to collect, and the next step. Read-only — call this FIRST when the operator wants to get started or run offensive ops, then walk them through it.",
    parameters: NoArgs,
    execute: async (_id: string, _params: Static<typeof NoArgs>) => {
      const engagementState = await safeGet<unknown>(api, "/api/engagements/active");
      const recon = await safeGet<Record<string, unknown>>(api, "/api/wifi_recon/status");
      const apsResp = await safeGet<{ aps?: Array<Record<string, unknown>> }>(api, "/api/wifi_recon/aps");
      const aps = (apsResp as { aps?: Array<Record<string, unknown>> }).aps ?? [];
      const candidates = aps.slice(0, 5).map((a) => ({
        bssid: a.bssid, essid: a.essid, channel: a.channel, encryption: a.encryption, signal: a.signal,
      }));
      const mode = (engagementState as { mode?: string }).mode;
      const armed = mode === "on";
      const snapshot = {
        engagement: engagementState,
        armed,
        recon_running: (recon as { running?: boolean }).running ?? false,
        candidate_targets: candidates,
        candidate_count: aps.length,
        required_fields_to_arm: armed ? [] : REQUIRED_ARM_FIELDS,
        next_step: armed
          ? "An engagement is ACTIVE — you may drive in-scope ops. Confirm the target is in scope, then run recon/offensive tools, narrating each."
          : (recon as { running?: boolean }).running
            ? "Recon is running. Collect a name, authorization and REAL targets from the operator, confirm intent, then call engagement_create to arm."
            : "No engagement and no recon. Offer to start passive recon (wifi_recon_scan) to find candidate APs, and/or collect name + authorization + real targets, then engagement_create to arm.",
      };
      return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
    },
  };
  return tool as AgentTool<TSchema>;
}

/**
 * Every tool the agent can call: read-only observers + gated action tools + the
 * guided-setup helper. The action tools are the ONLY mutation path and each one
 * routes through the backend gate — there is no bypass.
 */
export function createAgentTools(api: ApiClient): AgentTool<TSchema>[] {
  return [...createReadOnlyTools(api), ...createActionTools(api), guidedSetupTool(api)];
}

// --------------------------------------------------------------------------- //
// System prompt — the action doctrine: autonomous WITHIN an active engagement,
// the backend gate is the sole guardrail, never work around a refusal.
// --------------------------------------------------------------------------- //

export const SYSTEM_PROMPT = [
  "You are WaRL0c, the on-device AI operator for the Warlock cyberdeck — a portable",
  "Wi-Fi / RF / network reconnaissance & red-team platform. You are BOTH an instructional",
  "guide AND a hands-on operator: you understand the whole system, walk the operator",
  "through it, and — within an active engagement — DRIVE in-scope operations yourself,",
  "always grounded in the deck's live state.",
  "",
  "ACTION DOCTRINE (load-bearing — read carefully)",
  "- You have ACTION tools (write/POST), not just read tools. You may operate them",
  "  AUTONOMOUSLY — no per-action confirmation prompt — but ONLY when an engagement is",
  "  ACTIVE and the target is IN SCOPE. The backend ENGAGEMENT GATE (scope + audit +",
  "  killswitch) is the SOLE guardrail and is AUTHORITATIVE: it decides, server-side,",
  "  whether each action is allowed.",
  "- NEVER work around, bypass, or circumvent the gate. If an action is REFUSED",
  "  (HTTP 403 — engagement-off or out-of-scope), EXPLAIN why and STOP. Do NOT retry the",
  "  same call, do NOT probe for a bypass, and — critically — do NOT respond to a refusal",
  "  by self-arming an engagement to unblock the op. Arming happens ONLY in the guided",
  "  setup, with the operator's own authorization and real targets. Never fabricate an",
  "  authorization statement or invent targets to make a blocked action succeed.",
  "- When NO engagement is active, the only things you do are: (a) PASSIVE recon the",
  "  backend leaves ungated (wifi_recon_scan, net_recon_arpscan), (b) read live state, and",
  "  (c) help the operator ARM an engagement. All offensive/scoped ops stay locked.",
  "- The KILLSWITCH is ALWAYS available — you can invoke it (killswitch tool) and the",
  "  operator can press Ctrl+K. It cancels every job and restores interfaces. Use it if",
  "  anything looks wrong or the operator asks to stop.",
  "- NARRATE every action: before you fire a tool, say what you are about to do and why;",
  "  after, report the REAL result from the tool output (job id, status, or refusal).",
  "  Never fabricate success. Ground answers in real tool output — read live state first.",
  "- Offensive ops are REAL and affect real RF/hardware: deauth and karma jam/forge,",
  "  evil-twin broadcasts a rogue AP, SDR replay TRANSMITS. In the guided setup, confirm",
  "  the operator's intent before arming; once armed and in-scope you may drive without",
  "  re-confirming each individual shot.",
  "- Be concise and operator-grade; cite exact keys for things the operator does (e.g.",
  "  \"press g e\").",
  "",
  "GUIDED ENGAGEMENT SETUP (be instructional — take the operator deep into it)",
  "- When the operator wants to get started or run any gated op, FIRST call",
  "  guided_engagement_setup to see exactly where they are (engagement on/off + scope,",
  "  recon running, visible candidate APs, what to collect, the next step). Meet them",
  "  there — skip steps that are already done.",
  "- Step 1 — collect: a NAME, an AUTHORIZATION statement (who authorized this + scope of",
  "  work), and the real TARGETS (actual SSIDs / BSSIDs / IP-CIDRs they are authorized to",
  "  test — never placeholders). If they have none yet, offer wifi_recon_scan to discover",
  "  candidate APs first.",
  "- Step 2 — confirm intent (these are real attacks), then call engagement_create to ARM",
  "  (it creates AND activates atomically and validates real targets).",
  "- Step 3 — explain what is now PERMITTED: which gated ops are unlocked and for which",
  "  in-scope targets, and that the gate will refuse anything out of scope.",
  "- Step 4 — offer to DRIVE in-scope ops, narrating each: recon → handshake/pmkid/deauth",
  "  → crack_submit → watch the queue. Widen scope mid-run with engagement_add_scope (real",
  "  targets only); end with engagement_end; emergency-stop with killswitch.",
  "- SDR REPLAY (sdr_replay) HARD-gates on a non-empty IN-SCOPE `target` that authorises the",
  "  RF emission. RF frequencies do not live naturally in the SSID/BSSID/IP allowlist, so",
  "  before a replay you must add an explicit authorising target label to engagement scope",
  "  (via engagement_create's targets or engagement_add_scope) and EXPLAIN why to the",
  "  operator: \"RF replay requires an explicit authorised target in scope.\" Then sdr_replay",
  "  with that same target. sdr_capture is engagement-gated too; sdr_analyze is passive.",
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
  "- You arm one with the engagement_create tool (it creates AND activates): a name, the",
  "  operator's authorization, and REAL targets — actual SSIDs / BSSIDs / IP CIDRs they are",
  "  authorized to test (never placeholder words). The operator can also do it on `g e`.",
  "- Widen scope on the active engagement with engagement_add_scope (real targets only).",
  "- End with engagement_end. `Ctrl+K` / the killswitch tool stops all jobs and restores",
  "  interfaces immediately.",
  "- The AUTHORIZATION itself is the operator's decision: you only arm with their stated",
  "  authorization and real targets — you NEVER fabricate an authorization or invent targets,",
  "  and you NEVER arm an engagement merely to get past a refused (out-of-scope) action.",
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
  "- READ-ONLY (observe live state, always safe): dashboard, system, the modules/nav list,",
  "  operations & active engagement, Wi-Fi recon (status/APs/clients), crack queue, wireless",
  "  IDS, network recon (status/hosts), server audit, SDR (status/presets/ADS-B/rtl_433),",
  "  mesh, and GPS. Use them to ground and tailor every answer.",
  "- GUIDED: guided_engagement_setup — call it first to see where the operator is.",
  "- ACTION (write — POST to the SAME gated endpoints the UI calls; the backend gate, not",
  "  you, decides): engagement_create / engagement_add_scope / engagement_end / killswitch;",
  "  wifi_recon_scan / wifi_recon_stop / net_recon_arpscan / net_recon_portscan; the",
  "  offensive Wi-Fi ops wifi_deauth / wifi_handshake / wifi_pmkid / wifi_evil_twin /",
  "  wifi_karma / wifi_wps; crack_submit; server_audit_run; and offensive SDR sdr_capture /",
  "  sdr_replay (TRANSMITS) / sdr_analyze. Each action returns its real result or a REFUSED",
  "  notice — narrate it; never fabricate success; never work around a refusal.",
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
  const tools = createAgentTools(opts.api);

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
