// ============================================================================
// ChatApp — the standalone `warlock-chat` UI (NOT embedded in the HUD).
//
// WHY STANDALONE: the embedded chat lived inside the multi-screen app, which
// re-renders every second (HUD clock + telemetry polls). Ink cannot clear a
// frame taller than the terminal, so long answers stacked headers and blanked.
// Here nothing competes and the committed conversation goes through Ink's
// <Static> → written to the terminal's REAL scrollback exactly once, never
// re-rendered. Only the in-flight turn + the bordered input console re-render.
//
// GLOW-UP (W1): branded WARLOCK banner + capability welcome (Static splash,
// printed once), markdown-rendered answers, an animated braille "thinking"
// indicator in the live region, a bordered console with a titled header, and a
// status footer. The agent BRAIN is reused unchanged: this component only
// consumes an AgentRunner (lib/agent.ts) — no tools, prompt, or provider logic.
// ============================================================================

import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import { Banner, Capabilities } from "../components/Banner.js";
import { BrailleSpinner } from "../components/BrailleSpinner.js";
import { Markdown } from "../components/Markdown.js";
import type { AgentRunner } from "../lib/agent.js";
import { COLORS, TEXT } from "../lib/theme.js";

export interface ChatAppProps {
  runner: AgentRunner;
  /** Provider id for the header/footer (display only). */
  provider?: string;
  /** Model id for the header/footer (display only). */
  model: string;
  /** App version for the header. */
  version?: string;
  /** Unset provider env vars; non-empty → show a configure hint. */
  missing: string[];
}

type LogItem =
  | { id: string; kind: "banner" }
  | { id: string; kind: "welcome" }
  | { id: string; kind: "exchange"; user: string; assistant: string; error: boolean; width: number };

function ExchangeView({
  user,
  assistant,
  error,
  width,
}: {
  user: string;
  assistant: string;
  error: boolean;
  width: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
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
          {error ? (
            <Text color={COLORS.pink} wrap="wrap">
              {assistant}
            </Text>
          ) : (
            // Markdown only on the COMMITTED answer (never the streaming partial).
            <Markdown width={Math.max(20, width - 6)} color={TEXT.body}>
              {assistant}
            </Markdown>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export function ChatApp({ runner, provider = "", model, version = "0.1.0", missing }: ChatAppProps) {
  const { exit } = useApp();
  const rawOk = !!useStdin().isRawModeSupported;
  const { stdout } = useStdout();
  const cols = Math.max(40, (stdout?.columns ?? 100) - 2);

  const [log, setLog] = useState<LogItem[]>(() => [
    { id: "banner", kind: "banner" },
    { id: "welcome", kind: "welcome" },
  ]);
  const [input, setInput] = useState("");
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastMs, setLastMs] = useState<number | null>(null);

  // ink-text-input can hold a stale input handler under rapid input; read live
  // values from refs so submit always uses the latest typed text.
  const inputRef = useRef("");
  inputRef.current = input;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const idRef = useRef(0);

  const turns = log.reduce((n, l) => (l.kind === "exchange" ? n + 1 : n), 0);
  const providerModel = `${provider || "?"}:${model || "unconfigured"}`;

  const submit = async () => {
    const q = inputRef.current.trim();
    if (!q || busyRef.current) return;
    setInput("");
    setPendingQ(q);
    setPartial("");
    setTool(null);
    setBusy(true);
    const startedAt = Date.now();
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
        {
          id,
          kind: "exchange",
          user: q,
          assistant: errored ? answer : answer || "(empty answer)",
          error: errored,
          width: colsRef.current,
        },
      ]);
      setLastMs(Date.now() - startedAt);
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
          item.kind === "banner" ? (
            <Banner key={item.id} />
          ) : item.kind === "welcome" ? (
            <Box key={item.id} marginTop={1}>
              <Capabilities />
            </Box>
          ) : (
            <ExchangeView
              key={item.id}
              user={item.user}
              assistant={item.assistant}
              error={item.error}
              width={item.width}
            />
          )
        }
      </Static>

      {/* Bordered live console — the only persistent re-rendering region. The
          border can't wrap <Static> (it's hoisted to scrollback above), so it
          frames the title + in-flight turn + input + status. */}
      <Box flexDirection="column" borderStyle="round" borderColor={COLORS.violet} paddingX={1} marginTop={1}>
        <Text>
          <Text color={COLORS.violet}>✦ WaRL0c Assistant</Text>
          <Text color={TEXT.dim}>
            {" "}
            · v{version} · {providerModel} · read-only
          </Text>
        </Text>

        {missing.length ? (
          <Text color={COLORS.amber}>⚠ set {missing.join(", ")} in /opt/warlock/agent.env</Text>
        ) : null}

        {/* Dynamic in-flight turn (NEVER placed in Static). */}
        {pendingQ != null ? (
          <Box flexDirection="column" marginTop={1}>
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
                <Text>
                  <BrailleSpinner name="orbit" color={COLORS.cyan} />
                  <Text color={TEXT.dim}> {tool ? `reading ${tool}…` : "thinking…"}</Text>
                </Text>
              </Box>
            </Box>
            {partial ? (
              <Box marginLeft={5}>
                <Text color={TEXT.dim} wrap="wrap">
                  {partial}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {/* Prompt */}
        <Box marginTop={pendingQ != null ? 1 : 0}>
          <Text color={COLORS.violet}>› </Text>
          {rawOk ? (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              focus={!busy}
              placeholder={busy ? "…" : "ask the deck"}
            />
          ) : (
            <Text color={TEXT.dim}>[non-interactive stdin — run warlock-chat in a real terminal]</Text>
          )}
        </Box>

        {/* Status footer */}
        <Text color={TEXT.dim}>
          {providerModel} · read-only · {turns} turn{turns === 1 ? "" : "s"} ·{" "}
          {lastMs != null ? `last ${lastMs}ms` : "ready"} · Ctrl+C quit
        </Text>
      </Box>
    </Box>
  );
}
