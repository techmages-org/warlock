// ESP32 Companion — Ink TUI screen.
// Polls GET /api/esp32_companion/status. Backend feature is pending; screen
// shows the real "pending" status and the developer roadmap from the todo list.
// No interactive actions are available until the Marauder serial bridge lands.

import { Box, Text } from "ink";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

type Esp32Status = {
  module: string;
  label: string;
  status: string;
  requires_engagement: boolean;
  todo: string[];
};

export function Screen() {
  const api = useApi();
  const { data, error } = usePoll<Esp32Status>(
    () => api.get<Esp32Status>("/api/esp32_companion/status"),
    5000,
    [api],
  );

  if (error) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="14 ESP32" title="ESP32 Companion" state="LINK ERROR" icon="⬡" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>esp32_companion error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="14 ESP32" title="ESP32 Companion" state="ACQUIRING" icon="⬡" />
        <Tile title="STATUS" led="amber" width={40}>
          <Text color={TEXT.dim}>acquiring status…</Text>
        </Tile>
      </Box>
    );
  }

  const isPending = data.status === "pending";
  const statusLed: LEDColor = isPending ? "amber" : "mint";

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="14 ESP32"
        title="ESP32 Companion"
        state={isPending ? "PENDING" : data.status.toUpperCase()}
        icon="⬡"
        right={<Text color={TEXT.dim}>{data.module}</Text>}
      />

      <Box>
        <Tile title="COMPANION STATUS" led={statusLed} width={36}>
          <Text color={COLORS[statusLed]} bold>
            {isPending ? "COMPANION OFFLINE" : data.status.toUpperCase()}
          </Text>
          <Text color={TEXT.dim}>{data.label}</Text>
        </Tile>

        <Tile title="FEATURE ROADMAP" led="violet" width={80}>
          {data.todo.length === 0 ? (
            <Text color={TEXT.dim}>no pending tasks</Text>
          ) : (
            data.todo.map((item, i) => (
              <Box key={i}>
                <Text color={COLORS.violet}>▸ </Text>
                <Text color={TEXT.body} wrap="truncate-end">
                  {item}
                </Text>
              </Box>
            ))
          )}
        </Tile>
      </Box>

      <Tile title="SERIAL BRIDGE" led="dim" width={116}>
        <Text color={TEXT.dim}>
          Marauder bridge not yet active · awaiting /dev/ttyUSB* or /dev/ttyACM* enumeration
        </Text>
      </Tile>
    </Box>
  );
}
