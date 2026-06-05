// One-line module title strip — Ink analogue of the web ModuleHeader. Screens
// render this at the top so the operator always sees MOD // <code> :: <state>.

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { COLORS, TEXT } from "../lib/theme.js";

export function ModuleHeader({
  code,
  title,
  state,
  icon,
  right,
}: {
  code: string;
  title: string;
  state: string;
  icon?: string;
  right?: ReactNode;
}) {
  return (
    <Box justifyContent="space-between">
      <Box>
        {icon ? <Text color={COLORS.violet}>{icon} </Text> : null}
        <Text color={TEXT.dim}>MOD // </Text>
        <Text color={COLORS.violet}>{code} </Text>
        <Text color={TEXT.dim}>:: </Text>
        <Text color={COLORS.amber}>{state}</Text>
        <Text color={TEXT.hi}>  {title}</Text>
      </Box>
      {right ? <Box>{right}</Box> : null}
    </Box>
  );
}
