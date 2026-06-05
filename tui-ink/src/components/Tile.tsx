// Bordered HUD tile — Ink analogue of the web Tile. A rounded box whose border
// colour tracks the tile's status LED, with a header row (title + LED) and a
// body. Kept SHORT (low-height geometry: uConsole 1280×480). Pass an explicit
// `width` so tiles pack predictably into the ~120-col dashboard grid.

import { Box, Text, type DOMElement } from "ink";
import type { ReactNode } from "react";
import { ledColor, TEXT, type LEDColor } from "../lib/theme.js";
import { StatusLED } from "./StatusLED.js";

export function Tile({
  title,
  led = "dim",
  width,
  headerRight,
  children,
  ref,
}: {
  title?: string;
  led?: LEDColor;
  width?: number;
  headerRight?: ReactNode;
  children?: ReactNode;
  ref?: React.Ref<DOMElement>;
}) {
  return (
    <Box
      ref={ref}
      flexDirection="column"
      borderStyle="round"
      borderColor={ledColor(led)}
      paddingX={1}
      width={width}
    >
      {(title || headerRight) && (
        <Box justifyContent="space-between">
          <Text color={TEXT.dim}>{title}</Text>
          <Box>
            {headerRight}
            {led ? <StatusLED color={led} /> : null}
          </Box>
        </Box>
      )}
      {children}
    </Box>
  );
}
