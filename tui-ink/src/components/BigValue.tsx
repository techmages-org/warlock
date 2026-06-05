// Prominent metric readout — Ink analogue of the web BigValue. A bold coloured
// value with an optional dim unit suffix, on one line (terminal has no font
// scaling, so "big" = bold + colour).

import { Text } from "ink";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

export function BigValue({
  value,
  unit,
  color = "amber",
}: {
  value: string | number;
  unit?: string;
  color?: LEDColor;
}) {
  return (
    <Text>
      <Text bold color={COLORS[color]}>
        {value}
      </Text>
      {unit ? <Text color={TEXT.dim}> {unit}</Text> : null}
    </Text>
  );
}
