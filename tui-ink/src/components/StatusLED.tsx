// A single coloured status dot — the Ink analogue of the web StatusLED.
// In a terminal we render a filled circle glyph in the LED's hex colour.

import { Text } from "ink";
import { ledColor, type LEDColor } from "../lib/theme.js";

export function StatusLED({ color, glyph = "●" }: { color: LEDColor; glyph?: string }) {
  return <Text color={ledColor(color)}>{glyph}</Text>;
}
