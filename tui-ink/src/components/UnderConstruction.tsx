// Compile-shim placeholder used by the 15 not-yet-built screens. Renders an
// unmistakable UNDER CONSTRUCTION banner so the package compiles and the nav
// works end-to-end while W1–W4 fill in real screens. This lives in components/
// (NOT screens/) on purpose: the per-shim TODO/marker token must appear exactly
// once per shim FILE under src/screens — never in this shared component.

import { Box, Text } from "ink";
import { COLORS, TEXT } from "../lib/theme.js";

export function UnderConstruction({ label }: { label: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.amber}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={COLORS.amber}>
        ⏳ UNDER CONSTRUCTION — {label}
      </Text>
      <Text color={TEXT.dim}>This screen is not built yet. Replace its shim file to implement it.</Text>
    </Box>
  );
}
