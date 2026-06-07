// ============================================================================
// ChatApp — the standalone `warlock-chat` UI (NOT embedded in the HUD).
//
// WHY STANDALONE: the embedded chat lived inside the multi-screen app, which
// re-renders every second (HUD clock + telemetry polls). Ink cannot clear a
// frame taller than the terminal, so long answers stacked headers and blanked.
// Here there is no competing chrome and the committed conversation goes through
// Ink's <Static> → it is written to the terminal's REAL scrollback exactly once
// and never re-renders. Only the in-flight turn + the prompt re-render.
//
// The agent BRAIN is reused unchanged: this component only consumes an
// AgentRunner (lib/agent.ts). No tools, no prompt, no provider logic here.
// ============================================================================

import { Box, Static, Text, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import type { AgentRunner } from "../lib/agent.js";
import { COLORS, TEXT } from "../lib/theme.js";

export interface ChatAppProps {
  runner: AgentRunner;
  /** Model id for the header line (display only). */
  model: string;
  /** Unset provider env vars; non-empty → show a configure hint. */
  missing: string[];
}

type HeaderItem = { id: string; kind: "header"; text: string };
type Exchange = { id: string; kind: "exchange"; user: string; assistant: string; error: boolean };
type LogItem = HeaderItem | Exchange;

function ExchangeView({ user, assistant, error }: { user: string; assistant: string; error: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={5}>
          <Text color={COLORS.cyan}>you </Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={TEXT.body} wrap="wrap">
            {user}
          </Text>
        </Box>
      </Box>
      <Box>
        <Box width={5}>
          <Text color={error ? COLORS.pink : COLORS.mint}>{error ? "err " : "war "}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={error ? COLORS.pink : TEXT.body} wrap="wrap">
            {assistant}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export function ChatApp({ runner, model, missing }: ChatAppProps) {
  const { exit } = useApp();
  const rawOk = !!useStdin().isRawModeSupported;

  const [log, setLog] = useState<LogItem[]>(() => [
    { id: "header", kind: "header", text: `✦ WaRL0c Assistant · read-only · ${model || "unconfigured"}` },
  ]);
  const [input, setInput] = useState("");
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ink-text-input can hold a stale input handler under rapid input; read live
  // values from refs so submit always uses the latest typed text.
  const inputRef = useRef("");
  inputRef.current = input;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const idRef = useRef(0);

  const submit = async () => {
    const q = inputRef.current.trim();
    if (!q || busyRef.current) return;
    setInput("");
    setPendingQ(q);
    setPartial("");
    setTool(null);
    setBusy(true);
    let answer = "";
    let errored = false;
    try {
      answer = await runnerRef.current.ask(q, {
        onToolCall: (n) => setTool(n),
        onDelta: (d) => setPartial((s) => s + d),
      });
    } catch (e: unknown) {
      errored = true;
      answer = e instanceof Error ? e.message : String(e);
    } finally {
      const id = `x${++idRef.current}`;
      // COMMIT the completed exchange to <Static> → terminal scrollback, once.
      setLog((l) => [
        ...l,
        { id, kind: "exchange", user: q, assistant: errored ? answer : answer || "(empty answer)", error: errored },
      ]);
      setPendingQ(null);
      setPartial("");
      setTool(null);
      setBusy(false);
    }
  };

  // Ctrl+C quits even when nothing is focused/typed.
  useInput(
    (i, key) => {
      if (key.ctrl && i === "c") exit();
    },
    { isActive: rawOk },
  );

  return (
    <Box flexDirection="column">
      {/* Committed log → native scrollback, each item rendered exactly once. */}
      <Static items={log}>
        {(item) =>
          item.kind === "header" ? (
            <Box key={item.id} marginBottom={1}>
              <Text color={COLORS.violet}>{item.text}</Text>
              <Text color={TEXT.dim}> · grounded in live read-only tools · Ctrl+C to quit</Text>
            </Box>
          ) : (
            <ExchangeView key={item.id} user={item.user} assistant={item.assistant} error={item.error} />
          )
        }
      </Static>

      {missing.length ? (
        <Box marginBottom={1}>
          <Text color={COLORS.amber}>
            ⚠ provider not configured — set {missing.join(", ")} in /opt/warlock/agent.env
          </Text>
        </Box>
      ) : null}

      {/* Dynamic region: the in-flight turn (NEVER placed in Static). */}
      {pendingQ != null ? (
        <Box flexDirection="column">
          <Box>
            <Box width={5}>
              <Text color={COLORS.cyan}>you </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={TEXT.body} wrap="wrap">
                {pendingQ}
              </Text>
            </Box>
          </Box>
          <Box>
            <Box width={5}>
              <Text color={COLORS.violet}>war </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={TEXT.dim} wrap="wrap">
                {partial ? partial : tool ? `⟳ reading ${tool}…` : "⟳ thinking…"}
              </Text>
            </Box>
          </Box>
        </Box>
      ) : null}

      {/* Prompt (re-renders; the only persistent live region). */}
      <Box>
        <Text color={COLORS.violet}>› </Text>
        {rawOk ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            focus={!busy}
            placeholder={busy ? "…" : "ask the deck (Ctrl+C quits)"}
          />
        ) : (
          <Text color={TEXT.dim}>[non-interactive stdin — run warlock-chat in a real terminal]</Text>
        )}
      </Box>
    </Box>
  );
}
