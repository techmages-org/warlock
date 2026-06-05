// Offensive SDR screen — engagement-gated. Shows the engagement gate when no
// active engagement; when engaged shows module status + capability roadmap.
// Module id: sdr_offensive  (requires_engagement = True).

import { Box, Text, useStdout } from "ink";
import { EngagementBanner } from "../components/EngagementBanner.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import type { EngagementStatus } from "../lib/types.js";
import { COLORS, TEXT } from "../lib/theme.js";

// App-shell chrome consumed outside this screen.
const APP_CHROME = 8;

type SdrOffensiveStatus = {
  module: string;
  label: string;
  status: string;
  requires_engagement: boolean;
  todo: string[];
};

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 120;

  const { data: eng } = usePoll<EngagementStatus>(
    () => api.get<EngagementStatus>("/api/engagements/active"),
    2000,
    [api],
  );

  const { data: modStatus, error: modErr } = usePoll<SdrOffensiveStatus>(
    () => api.get<SdrOffensiveStatus>("/api/sdr_offensive/status"),
    5000,
    [api],
  );

  const engMode = eng?.mode;
  const engaged = engMode === "on";
  const gated = engMode === "off";

  // ── geometry ──────────────────────────────────────────────────────────────
  // body = rows available to this screen after app-shell chrome.
  const body = Math.max(6, rows - APP_CHROME);
  // compact = we're at the stress terminal (24-row SSH/small window).
  // At compact: gate tile uses 2 lines (saves 1 row) and hw_note is hidden (saves 1 row).
  const compact = body <= 16;

  // Fixed rows in gated state (the worst case — most chrome):
  //   ModuleHeader(1) + marginTop+EngagementBanner(2) + marginTop+gate_tile(6 compact / 7 full)
  //   + marginTop(1) + roadmap_tile_overhead(3) + hw_note(0 compact / 1 full)
  const gateTileH = compact ? 5 : 6;   // border(1)+title(1)+content_lines(2 or 3)+border(1)
  const hwNoteRows = compact ? 0 : 1;
  // fixedAbove = everything except the variable todo list + indicator in the roadmap tile.
  const fixedAbove = 1/*hdr*/ + 2/*margin+banner*/ + (1 + gateTileH)/*margin+gate*/ + 1/*margin*/ + 3/*roadmap_ohd*/;
  // -1 for the "+N more" indicator row (always reserve a slot when overflow expected).
  const maxTodo = Math.max(1, body - fixedAbove - hwNoteRows - 1/*indicator*/);

  // Dynamic roadmap tile width.
  const roadmapW = Math.max(40, Math.min(engaged ? 72 : 112, cols - 6));

  const todoItems = modStatus?.todo ?? [];
  const visibleTodos = todoItems.slice(0, maxTodo);
  const hiddenTodos = Math.max(0, todoItems.length - maxTodo);

  return (
    <Box flexDirection="column" paddingX={1}>
      <ModuleHeader
        code="05 SDR-OFF"
        title="Offensive SDR"
        icon="☢"
        state={!engMode ? "loading…" : engaged ? "ENGAGED" : "GATED"}
      />

      <Box marginTop={1}>
        <EngagementBanner />
      </Box>

      {/* ── engagement gate ── */}
      {gated && (
        <Box marginTop={1}>
          <Tile title="⚠  ENGAGEMENT REQUIRED" led="pink" width={72}>
            <Text bold color={COLORS.pink}>
              {"  "}! Offensive SDR requires an active engagement.
            </Text>
            <Text color={TEXT.dim}>
              {"  "}Start an engagement via Engagements (g e) to unlock.
            </Text>
            {!compact && (
              <Text color={TEXT.dim}>
                {"  "}All RF replay / analysis operations are gated until then.
              </Text>
            )}
          </Tile>
        </Box>
      )}

      {/* ── module content ── */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        {/* Status tile — only show detailed status when engaged */}
        {engaged && (
          <Tile title="MODULE STATUS" led="amber" width={38}>
            {modErr ? (
              <Text color="#ef4444">  error — {modErr}</Text>
            ) : modStatus ? (
              <>
                <Text color={TEXT.hi}>  {modStatus.label}</Text>
                <Text color={TEXT.dim}>  state: {modStatus.status}</Text>
                <Text color={TEXT.dim}>
                  {"  "}engagement: {modStatus.requires_engagement ? "required" : "open"}
                </Text>
              </>
            ) : (
              <Text color={TEXT.dim}>  loading…</Text>
            )}
          </Tile>
        )}

        {/* Capability roadmap — visible regardless of engagement */}
        <Tile title="CAPABILITY ROADMAP" led="dim" width={roadmapW}>
          {todoItems.length > 0 ? (
            <>
              {visibleTodos.map((item, i) => (
                <Text key={i} color={TEXT.dim}>
                  {"  "}○ {item}
                </Text>
              ))}
              {hiddenTodos > 0 && (
                <Text color={TEXT.dim}>  +{hiddenTodos} more</Text>
              )}
            </>
          ) : modErr ? (
            <Text color="#ef4444">  {modErr}</Text>
          ) : (
            <Text color={TEXT.dim}>  loading capability list…</Text>
          )}
          {!compact && (
            <Text color={TEXT.dim}>
              {"  "}Hardware note: RTL-SDR is RX-only. HackRF/LimeSDR needed for TX.
            </Text>
          )}
        </Tile>
      </Box>
    </Box>
  );
}
