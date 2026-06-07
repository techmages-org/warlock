// ============================================================================
// SlashMenu — a short, bounded command dropdown shown just above the input when
// the operator types "/". Presentational + reusable (W2). Kept intentionally
// small so the dynamic (non-Static) region stays a constant, minimal height.
// ============================================================================

import { Box, Text } from "ink";
import { COLORS, TEXT } from "../lib/theme.js";

export interface SlashCommand {
  name: string;
  desc: string;
}

export function SlashMenu({ commands, selected }: { commands: SlashCommand[]; selected: number }) {
  if (commands.length === 0) return null;
  return (
    <Box flexDirection="column">
      {commands.map((c, i) => {
        const on = i === selected;
        return (
          <Text key={c.name} color={on ? COLORS.cyan : TEXT.dim}>
            {on ? "›" : " "} <Text color={on ? COLORS.cyan : COLORS.violet}>{c.name.padEnd(8)}</Text>
            {"  "}
            <Text color={TEXT.dim}>{c.desc}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
