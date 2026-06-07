// Dynamic module nav rail — Ink analogue of the web ModuleRail. One horizontal
// line. The pinned `wireless` guided flow is first (frontend-only, not in
// /api/modules), then the modules fetched live from /api/modules, exactly like
// web App.tsx. The active module is highlighted; each entry shows its g+<key>.

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useApi } from "../context.js";
import { keyFor, PINNED_AGENT, PINNED_WIRELESS } from "../lib/nav.js";
import { COLORS, TEXT } from "../lib/theme.js";
import type { ModuleInfo } from "../lib/types.js";

export function Nav({ activeId }: { activeId: string }) {
  const api = useApi();
  const [modules, setModules] = useState<ModuleInfo[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .get<ModuleInfo[]>("/api/modules")
      .then((m) => {
        if (alive) setModules(m);
      })
      .catch(() => {
        if (alive) setModules([]);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const entries: ModuleInfo[] = [PINNED_AGENT, PINNED_WIRELESS, ...modules];

  return (
    <Box flexWrap="wrap">
      {entries.map((m) => {
        const active = m.id === activeId;
        const key = keyFor(m.id);
        const gate = m.requires_engagement ? "!" : "";
        return (
          <Box key={m.id} marginRight={1}>
            <Text
              bold={active}
              color={active ? COLORS.violet : TEXT.dim}
              backgroundColor={active ? "#1e1b2e" : undefined}
            >
              {m.icon} {m.label}
              {gate ? <Text color={COLORS.pink}>{gate}</Text> : null}
              {key ? <Text color={TEXT.dim}> ⟨{key}⟩</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
