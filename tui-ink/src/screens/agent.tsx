// ============================================================================
// A1 AGENT — WaRL0c on-device assistant chat screen.
//
// A terminal chat: the operator types a question, the PI agent loop (lib/agent
// .ts) runs over a configurable GLM/MiniMax provider, calling READ-ONLY tools
// against the live FastAPI to ground the answer. Single reusable runner per
// mount keeps short-term conversation context.
//
// INPUT MODEL: this is the only free-text screen, so app.tsx suppresses the
// global g/q/? chords while it is active (Esc → dashboard exits, Ctrl+C quits).
// Here we just own a TextInput. When stdin is not a TTY (headless agent pane)
// raw mode is unsupported, so we disable the input and say so — matching the
// app's headless guard — rather than crashing on setRawMode.
//
// Tests inject a fake runner via the `makeRunner` prop; the registry renders
// <Screen/> with no props → the real PI-backed runner. NO live LLM in tests.
// ============================================================================

import { Box, Text, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useMemo, useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { useApi } from "../context.js";
import {
  type AgentRunner,
  createAgentRunner,
  missingConfig,
  parseAgentConfig,
} from "../lib/agent.js";
import type { ApiClient } from "../lib/api.js";
import { COLORS, TEXT } from "../lib/theme.js";

type Role = "user" | "assistant" | "error";
interface ChatMsg {
  role: Role;
  text: string;
}

const ROLE_LABEL: Record<Role, string> = { user: "you", assistant: "war", error: "err" };
const ROLE_COLOR: Record<Role, string> = { user: COLORS.cyan, assistant: COLORS.mint, error: COLORS.pink };

export function Screen({ makeRunner }: { makeRunner?: (api: ApiClient) => AgentRunner } = {}) {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { stdout } = useStdout();

  const cfg = useMemo(() => parseAgentConfig(), []);
  const missing = useMemo(() => missingConfig(cfg), [cfg]);
  const runner = useMemo<AgentRunner>(
    () => (makeRunner ? makeRunner(api) : createAgentRunner({ api, config: cfg })),
    [api, makeRunner, cfg],
  );
  // A custom runner (tests / embedding) is self-configured — don't nag about env.
  const showConfigHint = !makeRunner && missing.length > 0;

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [partial, setPartial] = useState("");

  // ink-text-input's input handler can hold a stale closure under rapid input
  // (it re-subscribes between keystrokes; fine in a real terminal, raced in
  // tests). Read live values from refs so onSubmit always sees the latest.
  const inputRef = useRef("");
  inputRef.current = input;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const runnerRef = useRef(runner);
  runnerRef.current = runner;

  const onSubmit = async () => {
    const q = inputRef.current.trim();
    if (!q || busyRef.current) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    setTool(null);
    setPartial("");
    try {
      const answer = await runnerRef.current.ask(q, {
        onToolCall: (n) => setTool(n),
        onDelta: (d) => setPartial((s) => s + d),
      });
      setMessages((m) => [...m, { role: "assistant", text: answer || "(empty answer)" }]);
    } catch (e: unknown) {
      setMessages((m) => [...m, { role: "error", text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
      setTool(null);
      setPartial("");
    }
  };

  // Geometry: bound the visible history to the live terminal so the input row
  // and HUD chrome always stay on screen (uConsole ~24 rows).
  const cols = Math.max(24, (stdout?.columns ?? 120) - 4);
  const rows = stdout?.rows ?? 24;
  const bodyBudget = Math.max(3, rows - 11);
  const linesFor = (m: ChatMsg) => Math.max(1, Math.ceil((ROLE_LABEL[m.role].length + 2 + m.text.length) / cols));

  let used = 0;
  let firstShown = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = linesFor(messages[i]);
    if (used + cost > bodyBudget && firstShown !== messages.length) break;
    used += cost;
    firstShown = i;
  }
  const shown = messages.slice(firstShown);
  const earlier = firstShown;

  const provider = cfg.model ? `${cfg.provider}:${cfg.model}` : cfg.provider;

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="A1 AGENT"
        title="WaRL0c Assistant"
        state={busy ? "THINKING" : "READY"}
        icon="✦"
        right={<Text color={TEXT.dim}>read-only · {provider}</Text>}
      />

      {showConfigHint ? (
        <Box>
          <Text color={COLORS.amber}>
            ⚠ provider not configured — set {missing.join(", ")} (GLM 5.1 / MiniMax are OpenAI-compatible)
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {messages.length === 0 ? (
          <Text color={TEXT.dim}>
            Ask about the live deck — e.g. “what’s the deck status?”, “any access points?”, “is an engagement active?”
          </Text>
        ) : null}
        {earlier > 0 ? <Text color={TEXT.dim}>… +{earlier} earlier</Text> : null}
        {shown.map((m, i) => (
          <Box key={`${firstShown + i}-${m.role}`}>
            <Box width={5}>
              <Text color={ROLE_COLOR[m.role]}>{ROLE_LABEL[m.role]} </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={m.role === "error" ? COLORS.pink : TEXT.body} wrap="wrap">
                {m.text}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>

      {busy ? (
        <Box>
          <Text color={COLORS.violet}>⟳ thinking</Text>
          {tool ? <Text color={TEXT.dim}> · reading {tool}</Text> : null}
          {partial ? (
            <Text color={TEXT.dim} wrap="truncate-end">
              {" "}
              · {partial}
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={COLORS.violet}>› </Text>
        {rawOk ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            focus={!busy}
            placeholder={busy ? "…" : "ask the deck"}
          />
        ) : (
          <Text color={TEXT.dim}>[non-interactive stdin — run in a real terminal to chat]</Text>
        )}
      </Box>

      <Box>
        <Text color={TEXT.dim}>
          Enter send · Esc dashboard · grounded in live read-only tools (no actions)
        </Text>
      </Box>
    </Box>
  );
}
