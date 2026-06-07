// ============================================================================
// A1 AGENT — POINTER screen.
//
// The chat assistant no longer runs embedded in this HUD: it flickered/blanked
// because the multi-screen app re-renders every second (clock + polls) and Ink
// can't clear a frame taller than the terminal. It now runs as its own app,
// `warlock-chat`, which uses Ink <Static> for flicker-free, fully-scrollable
// history. This screen just points the operator there.
//
// Pure + static: no input, no context, no polling — so the global g/q/? keys
// work normally here (the app.tsx input-gate was removed with this change).
// ============================================================================

import { Box, Text } from "ink";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { COLORS, TEXT } from "../lib/theme.js";

export function Screen() {
  return (
    <Box flexDirection="column">
      <ModuleHeader code="A1 AGENT" title="WaRL0c Assistant" state="STANDALONE" icon="✦" />
      <Tile title="ASSISTANT RUNS AS ITS OWN APP" led="violet" width={68}>
        <Text color={TEXT.body}>The chat assistant now runs as a separate, flicker-free app</Text>
        <Text color={TEXT.body}>with full terminal scrollback — not embedded in this HUD.</Text>
        <Box marginTop={1}>
          <Text color={TEXT.dim}>Quit this HUD (</Text>
          <Text color={COLORS.violet}>q</Text>
          <Text color={TEXT.dim}>) and run:</Text>
        </Box>
        <Text color={COLORS.mint}>  warlock-chat</Text>
        <Text color={TEXT.dim}>Same brain — reads live state and drives in-scope ops</Text>
        <Text color={TEXT.dim}>under an active engagement (the gate authorizes each).</Text>
      </Tile>
    </Box>
  );
}
