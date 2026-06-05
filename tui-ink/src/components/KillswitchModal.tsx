// KILL SWITCH confirm modal — Ink analogue of the Textual killswitch screen.
// Rendered in place of the main content when armed (terminals have no real
// z-index/overlay; replacing the body is the low-height-friendly equivalent).
// Enter confirms → POST /api/engagements/killswitch; Esc cancels. The parent
// (app.tsx) owns the Enter/Esc input wiring and the busy/result state.

import { Box, Text } from "ink";
import { COLORS, TEXT } from "../lib/theme.js";
import type { KillswitchResult } from "../lib/types.js";

export function KillswitchModal({
  busy,
  result,
  error,
}: {
  busy: boolean;
  result: KillswitchResult | null;
  error: string | null;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={COLORS.pink}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={COLORS.pink}>
        ⚠  KILL SWITCH
      </Text>
      <Box marginTop={1}>
        <Text color={TEXT.hi}>
          Cancel all running jobs and restore interfaces to a safe state?
        </Text>
      </Box>
      <Box marginTop={1}>
        {busy ? (
          <Text color={COLORS.amber}>…executing…</Text>
        ) : error ? (
          <Text color={COLORS.pink}>killswitch failed: {error}</Text>
        ) : result ? (
          <Text color={COLORS.mint}>
            ✓ cancelled {result.cancelled_jobs} job(s) · restored{" "}
            {result.interfaces_restored} interface(s) — press Esc to close
          </Text>
        ) : (
          <Text color={TEXT.dim}>
            <Text color={COLORS.pink}>Enter</Text> confirm ·{" "}
            <Text color={COLORS.violet}>Esc</Text> cancel
          </Text>
        )}
      </Box>
    </Box>
  );
}
