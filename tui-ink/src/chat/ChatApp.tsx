// ============================================================================
// ChatApp — the standalone `warlock-chat` UI.
//
// FLOOD FIX (this wave): the bug was NOT conversation growth — it was IN-TURN
// re-rendering. The old dynamic region was a TALL bordered box (header + the
// GROWING streaming answer + input + footer) that the braille animation
// re-rendered ~10×/sec; Ink can't redraw a frame taller than the terminal in
// place, so every tick left a copy in scrollback → a single short question
// flooded the screen with stacked headers.
//
// The fix:
//  • Banner + header + capability welcome are the first <Static> items →
//    printed ONCE to scrollback, never re-rendered.
//  • Each completed exchange is ONE <Static> item (markdown), committed once.
//  • The dynamic (non-Static) region is MINIMAL and FIXED height: a single
//    braille "working…" line (in-flight only) + the input + the status footer.
//    NO header, NO border, NO growing answer here — so its height is constant
//    across braille ticks and Ink redraws it in place (no scrollback copies).
//  • We do NOT live-render the streaming answer (live token streaming is a
//    non-goal this wave). Spinner while working → commit the full markdown
//    answer to <Static> once on completion.
//
// The agent BRAIN is reused unchanged (AgentRunner from lib/agent.ts).
// ============================================================================

import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import { Banner, Capabilities } from "../components/Banner.js";
import { BrailleSpinner } from "../components/BrailleSpinner.js";
import { Markdown } from "../components/Markdown.js";
import { SlashMenu, type SlashCommand } from "../components/SlashMenu.js";
import type { AgentRunner } from "../lib/agent.js";
import { COLORS, TEXT } from "../lib/theme.js";

export interface ChatAppProps {
  runner: AgentRunner;
  provider?: string;
  model: string;
  version?: string;
  missing: string[];
}

type LogItem =
  | { id: string; kind: "banner" }
  | { id: string; kind: "header" }
  | { id: string; kind: "welcome" }
  | { id: string; kind: "info"; title: string; body: string; width: number }
  | { id: string; kind: "exchange"; user: string; assistant: string; error: boolean; width: number };

const COMMANDS: SlashCommand[] = [
  { name: "/help", desc: "show available commands" },
  { name: "/tools", desc: "list the read-only tools" },
  { name: "/model", desc: "show provider / model" },
  { name: "/clear", desc: "clear the conversation view" },
  { name: "/quit", desc: "exit warlock-chat" },
];

const HELP_MD = [
  "**Commands**",
  "- `/help` — show this list",
  "- `/tools` — list the read-only tools I can call",
  "- `/model` — show the configured provider / model",
  "- `/clear` — clear the conversation view",
  "- `/quit` — exit warlock-chat",
  "",
  "Otherwise just type a question. I read live deck state (read-only) and guide you;",
  "you press the keys. Tip: `g e` operations · `g f` wireless · `g c` crack.",
].join("\n");

function ExchangeView({ user, assistant, error, width }: { user: string; assistant: string; error: boolean; width: number }) {
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
            <Markdown width={Math.max(20, width - 6)} color={TEXT.body}>
              {assistant}
            </Markdown>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function InfoView({ title, body, width }: { title: string; body: string; width: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.cyan}>‹ {title} ›</Text>
      <Box marginLeft={2}>
        <Markdown width={Math.max(20, width - 2)} color={TEXT.body}>
          {body}
        </Markdown>
      </Box>
    </Box>
  );
}

export function ChatApp({ runner, provider = "", model, version = "0.1.0", missing }: ChatAppProps) {
  const { exit } = useApp();
  const rawOk = !!useStdin().isRawModeSupported;
  const { stdout } = useStdout();
  const cols = Math.max(40, (stdout?.columns ?? 100) - 2);
  const providerModel = `${provider || "?"}:${model || "unconfigured"}`;

  const splash = (): LogItem[] => [
    { id: "banner", kind: "banner" },
    { id: "header", kind: "header" },
    { id: "welcome", kind: "welcome" },
  ];

  const [log, setLog] = useState<LogItem[]>(splash);
  const [gen, setGen] = useState(0); // remount <Static> on /clear → fresh splash
  const [input, setInput] = useState("");
  const [sel, setSel] = useState(0);
  const [tool, setTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastMs, setLastMs] = useState<number | null>(null);

  const inputRef = useRef("");
  inputRef.current = input;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const selRef = useRef(0);
  selRef.current = sel;
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const idRef = useRef(0);
  const nextId = () => `e${++idRef.current}`;

  const turns = log.reduce((n, l) => (l.kind === "exchange" ? n + 1 : n), 0);
  const filtered = COMMANDS.filter((c) => c.name.startsWith(input.trim().toLowerCase()));
  const menuOpen = !busy && input.startsWith("/") && filtered.length > 0;
  const selClamped = Math.min(sel, Math.max(0, filtered.length - 1));

  const pushInfo = (title: string, body: string) =>
    setLog((l) => [...l, { id: nextId(), kind: "info", title, body, width: colsRef.current }]);

  const run = (name: string) => {
    const cmd = name.trim().toLowerCase();
    setInput("");
    setSel(0);
    if (cmd === "/quit") {
      exit();
      return;
    }
    if (cmd === "/clear") {
      setLog(splash());
      setGen((g) => g + 1);
      return;
    }
    if (cmd === "/tools") {
      setLog((l) => [...l, { id: nextId(), kind: "welcome" }]);
      return;
    }
    if (cmd === "/model") {
      pushInfo("model", `**${providerModel}** · v${version} · read-only`);
      return;
    }
    if (cmd === "/help") {
      pushInfo("commands", HELP_MD);
      return;
    }
    pushInfo("unknown command", `\`${cmd}\` is not a command — type \`/help\` for the list`);
  };

  const ask = async (q: string) => {
    setInput("");
    setBusy(true);
    setTool(null);
    const startedAt = Date.now();
    let answer = "";
    let errored = false;
    try {
      // No onDelta: we do NOT live-render the growing answer (that grew the
      // dynamic region → flood). Spinner while working, commit once on done.
      answer = await runnerRef.current.ask(q, { onToolCall: (n) => setTool(n) });
    } catch (e: unknown) {
      errored = true;
      answer = e instanceof Error ? e.message : String(e);
    } finally {
      setLog((l) => [
        ...l,
        { id: nextId(), kind: "exchange", user: q, assistant: errored ? answer : answer || "(empty answer)", error: errored, width: colsRef.current },
      ]);
      setLastMs(Date.now() - startedAt);
      setTool(null);
      setBusy(false);
    }
  };

  const submit = () => {
    const q = inputRef.current.trim();
    if (busyRef.current) return;
    if (q.startsWith("/")) {
      const f = COMMANDS.filter((c) => c.name.startsWith(q.toLowerCase()));
      run(f.length ? f[Math.min(selRef.current, f.length - 1)].name : q);
      return;
    }
    if (!q) return;
    void ask(q);
  };

  useInput(
    (i, key) => {
      if (key.ctrl && i === "c") {
        exit();
        return;
      }
      if (busyRef.current || !inputRef.current.startsWith("/")) return;
      const f = COMMANDS.filter((c) => c.name.startsWith(inputRef.current.toLowerCase()));
      if (f.length === 0) return;
      if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(f.length - 1, s + 1));
      else if (key.tab) run(f[Math.min(selRef.current, f.length - 1)].name);
    },
    { isActive: rawOk },
  );

  return (
    <Box flexDirection="column">
      {/* Banner + header + welcome + every exchange/info → printed ONCE to
          scrollback. Remounts (key=gen) only on /clear for a fresh splash. */}
      <Static key={gen} items={log}>
        {(item) => {
          switch (item.kind) {
            case "banner":
              return <Banner key={item.id} />;
            case "header":
              return (
                <Box key={item.id} flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color={COLORS.violet}>✦ WaRL0c Assistant</Text>
                    <Text color={TEXT.dim}>
                      {" "}
                      · v{version} · {providerModel} · read-only · type / for commands
                    </Text>
                  </Text>
                  {missing.length ? (
                    <Text color={COLORS.amber}>⚠ set {missing.join(", ")} in /opt/warlock/agent.env</Text>
                  ) : null}
                </Box>
              );
            case "welcome":
              return (
                <Box key={item.id} marginTop={1}>
                  <Capabilities />
                </Box>
              );
            case "info":
              return <InfoView key={item.id} title={item.title} body={item.body} width={item.width} />;
            case "exchange":
              return (
                <ExchangeView key={item.id} user={item.user} assistant={item.assistant} error={item.error} width={item.width} />
              );
          }
        }}
      </Static>

      {/* DYNAMIC region — minimal + fixed height. During a turn this is exactly
          three lines (spinner + input + footer); the slash menu only appears
          when idle (you cannot type while busy), so braille ticks never change
          the height → Ink redraws in place, no scrollback copies. */}
      <Box flexDirection="column" marginTop={1}>
        {menuOpen ? <SlashMenu commands={filtered.slice(0, 6)} selected={selClamped} /> : null}

        {busy ? (
          <Text>
            <BrailleSpinner name="braille" color={COLORS.cyan} />
            <Text color={TEXT.dim}> {tool ? `reading ${tool}…` : "working…"}</Text>
          </Text>
        ) : null}

        <Box>
          <Text color={COLORS.violet}>› </Text>
          {rawOk ? (
            <TextInput
              value={input}
              onChange={(v) => {
                setInput(v);
                setSel(0);
              }}
              onSubmit={submit}
              focus={!busy}
              placeholder={busy ? "…" : "ask the deck   ( / for commands )"}
            />
          ) : (
            <Text color={TEXT.dim}>[non-interactive stdin — run warlock-chat in a real terminal]</Text>
          )}
        </Box>

        <Text color={TEXT.dim}>
          {providerModel} · read-only · {turns} turn{turns === 1 ? "" : "s"} ·{" "}
          {lastMs != null ? `last ${lastMs}ms` : "ready"} · Ctrl+C quit
        </Text>
      </Box>
    </Box>
  );
}
