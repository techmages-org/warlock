// Root app: HUD chrome + dynamic nav + the active screen + global key handling.
//
// Layout (low-height, uConsole 1280×480 → ~24 rows):
//   row 0  HudBarTop          1 line
//   row 1  EngagementBanner   1 line
//   row 2  Nav rail           1 line
//   rows…  active screen / killswitch modal / help
//   last   HudBarBottom       1 line
//
// Global keys: `g`+<key> goto (chord), Ctrl+K killswitch (confirm modal),
// Ctrl+E engagement status (→ ops), `?` help, `q` quit.
//
// HEADLESS GUARD: useInput is registered with { isActive: isRawModeSupported }.
// When stdin is not a TTY (e.g. a backgrounded `node dist/cli.js` in an agent
// pane) raw mode is unsupported; gating isActive off it means setRawMode is
// never called, so the app renders + polls live telemetry WITHOUT crashing.

import { Box, Text, useApp, useInput, useStdin } from "ink";
import { useRef, useState } from "react";
import { EngagementBanner } from "./components/EngagementBanner.js";
import { HudBarBottom, HudBarTop } from "./components/HudBar.js";
import { KillswitchModal } from "./components/KillswitchModal.js";
import { Nav } from "./components/Nav.js";
import { useApi } from "./context.js";
import { KEY_TO_ID, NAV_KEYS, PINNED_WIRELESS } from "./lib/nav.js";
import { COLORS, TEXT } from "./lib/theme.js";
import type { KillswitchResult } from "./lib/types.js";
import { getScreen } from "./screens/registry.js";

const CHORD_MS = 900;

function Help() {
  const rows = Object.entries(NAV_KEYS);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.violet} paddingX={2} paddingY={1}>
      <Text bold color={COLORS.violet}>
        KEYBINDINGS
      </Text>
      <Box flexWrap="wrap" marginTop={1}>
        {rows.map(([id, key]) => (
          <Box key={id} width={26} marginRight={1}>
            <Text color={COLORS.violet}>g {key}</Text>
            <Text color={TEXT.dim}>  {id}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={TEXT.dim}>
          <Text color={COLORS.violet}>Ctrl+K</Text> killswitch · <Text color={COLORS.violet}>Ctrl+E</Text> engagement ·{" "}
          <Text color={COLORS.violet}>?</Text> toggle help · <Text color={COLORS.violet}>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}

export function App() {
  const api = useApi();
  const { exit } = useApp();
  // Coerce to a strict boolean: ink's useInput guards on `isActive === false`,
  // and useStdin() can return `isRawModeSupported` as `undefined` (not `false`)
  // under a non-TTY stdin — which would slip past that check and crash on
  // setRawMode. `!!` makes the headless guard reliable.
  const inputActive = !!useStdin().isRawModeSupported;

  const [activeId, setActiveId] = useState<string>("dashboard");
  const [pendingG, setPendingG] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const [killArmed, setKillArmed] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [killResult, setKillResult] = useState<KillswitchResult | null>(null);
  const [killError, setKillError] = useState<string | null>(null);

  const gTimer = useRef<NodeJS.Timeout | null>(null);

  const armChord = () => {
    setPendingG(true);
    if (gTimer.current) clearTimeout(gTimer.current);
    gTimer.current = setTimeout(() => setPendingG(false), CHORD_MS);
  };

  const goto = (id: string) => {
    setPendingG(false);
    if (gTimer.current) clearTimeout(gTimer.current);
    setActiveId(id);
  };

  const disarmKill = () => {
    setKillArmed(false);
    setKillBusy(false);
    setKillResult(null);
    setKillError(null);
  };

  const confirmKill = async () => {
    setKillBusy(true);
    setKillError(null);
    try {
      const r = await api.post<KillswitchResult>("/api/engagements/killswitch");
      setKillResult(r ?? { cancelled_jobs: 0, interfaces_restored: 0 });
    } catch (e: unknown) {
      setKillError(e instanceof Error ? e.message : String(e));
    } finally {
      setKillBusy(false);
    }
  };

  useInput(
    (input, key) => {
      // Killswitch modal owns input while armed.
      if (killArmed) {
        if (key.escape) disarmKill();
        else if (key.return && !killBusy && !killResult) void confirmKill();
        return;
      }
      // Chord completion: `g` was pressed, this is the second key.
      if (pendingG) {
        const id = KEY_TO_ID[input];
        if (id) goto(id);
        else {
          setPendingG(false);
          if (gTimer.current) clearTimeout(gTimer.current);
        }
        return;
      }
      // The Agent chat screen owns the keyboard for free-text input: suppress
      // the global single-key shortcuts (g chord / q quit / ? help) so the
      // operator can type those characters. Esc returns to the dashboard;
      // Ctrl+C still quits. Scoped to the agent screen only — every other
      // screen keeps its existing key behaviour.
      if (activeId === "agent") {
        if (key.escape) goto("dashboard");
        else if (key.ctrl && input === "c") exit();
        return;
      }
      if (key.ctrl && input === "k") {
        setHelpOpen(false);
        setKillArmed(true);
        return;
      }
      if (key.ctrl && input === "e") {
        goto("ops");
        return;
      }
      if (input === "?") {
        setHelpOpen((v) => !v);
        return;
      }
      if (input === "g") {
        armChord();
        return;
      }
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
        return;
      }
      if (key.escape && helpOpen) setHelpOpen(false);
    },
    { isActive: inputActive },
  );

  const Screen = getScreen(activeId);

  return (
    <Box flexDirection="column">
      <HudBarTop />
      <EngagementBanner />
      <Nav activeId={activeId} />
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {killArmed ? (
          <KillswitchModal busy={killBusy} result={killResult} error={killError} />
        ) : helpOpen ? (
          <Help />
        ) : (
          <Screen />
        )}
        {pendingG ? (
          <Box marginTop={1}>
            <Text color={COLORS.amber}>g… (press a screen key — ? for help)</Text>
          </Box>
        ) : null}
        {!inputActive ? (
          <Box marginTop={1}>
            <Text color={TEXT.dim}>
              [non-interactive stdin: keys disabled — telemetry still live; run in a real terminal for nav]
            </Text>
          </Box>
        ) : null}
      </Box>
      <HudBarBottom />
    </Box>
  );
}

// Keep a reference to the pinned wireless entry alive for type-checkers /
// future use (nav imports it; re-exported here for discoverability).
export { PINNED_WIRELESS };
