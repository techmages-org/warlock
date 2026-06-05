// Mesh command center — node table + broadcast message send form.
// Mirrors web/src/pages/Mesh.tsx. Module id: mesh.

import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import type { MeshNode } from "../lib/types.js";
import { COLORS, TEXT } from "../lib/theme.js";

// App-shell chrome consumed outside this screen (HUD bars + nav).
const APP_CHROME = 8;
// Fixed rows this screen renders OUTSIDE the scrollable node list:
//   ModuleHeader(1) + marginTop(1) + tile_borders+title(3) + col_header(1) + indicator(1) = 7
const SCREEN_FIXED = 7;

type MeshNodesResp = MeshNode[];
type SendResult = { ok: boolean; error?: string };

function fmtLastHeard(ts?: number | null): string {
  if (ts == null) return "—";
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - ts;
  if (diff < 10) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 120;

  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [nodeOffset, setNodeOffset] = useState(0);

  const { data: nodes, error: nodesErr } = usePoll<MeshNodesResp>(
    () => api.get<MeshNodesResp>("/api/mesh/nodes"),
    3000,
    [api],
  );

  // Compute list cap from actual terminal size.
  // body = rows available to this screen (after app-shell chrome).
  const body = Math.max(6, rows - APP_CHROME);
  // maxNodes = what fits in body minus every non-list row this screen renders.
  const maxNodes = Math.max(1, body - SCREEN_FIXED);

  // Hoist list derivation before useInput — hooks must not appear after early returns.
  const nodeList = nodes ?? [];
  const clampedNodeOffset = Math.min(
    nodeOffset,
    Math.max(0, nodeList.length - maxNodes),
  );

  // Use up/down arrows only — j/k would conflict with TextInput.
  useInput((_input, key) => {
    const maxOff = Math.max(0, nodeList.length - maxNodes);
    if (key.downArrow) setNodeOffset((o) => Math.min(o + 1, maxOff));
    if (key.upArrow) setNodeOffset((o) => Math.max(0, o - 1));
  });

  async function handleSend(submitted: string) {
    const text = submitted.trim();
    if (!text || sending) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await api.post<SendResult>("/api/mesh/send", { text, channel: 0 });
      setSendResult(res.ok ? "✓ sent" : "✗ failed");
      if (res.ok) setMsg("");
    } catch (e: unknown) {
      setSendResult(e instanceof Error ? e.message : "send failed");
    } finally {
      setSending(false);
    }
  }

  if (nodesErr && !nodes) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ModuleHeader code="01 MESH-TAC" title="Mesh" icon="⌬" state="ERROR" />
        <Box marginTop={1}>
          <Tile title="LINK ERROR" led="pink" width={60}>
            <Text color="#ef4444">  mesh error — {nodesErr}</Text>
          </Tile>
        </Box>
      </Box>
    );
  }

  if (!nodes) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ModuleHeader code="01 MESH-TAC" title="Mesh" icon="⌬" state="acquiring…" />
        <Box marginTop={1}>
          <Text color={TEXT.dim}>  acquiring mesh nodes…</Text>
        </Box>
      </Box>
    );
  }

  const nodeCount = nodes.length;

  // Dynamic tile widths bounded to terminal.
  const sendFormW = 30;
  const nodeTableW = Math.max(60, Math.min(82, cols - 2 - sendFormW - 1));

  // Node scroll window.
  const visibleNodes = nodeList.slice(clampedNodeOffset, clampedNodeOffset + maxNodes);
  const hiddenAbove = clampedNodeOffset;
  const hiddenBelow = Math.max(0, nodeList.length - clampedNodeOffset - maxNodes);

  return (
    <Box flexDirection="column" paddingX={1}>
      <ModuleHeader
        code="01 MESH-TAC"
        title="Mesh"
        icon="⌬"
        state={`${nodeCount} node${nodeCount === 1 ? "" : "s"}`}
      />

      <Box flexDirection="row" gap={1} marginTop={1}>
        {/* ── node table ── */}
        <Tile
          title={`MESH NODES (${nodeCount})`}
          led={nodeCount > 0 ? "cyan" : "dim"}
          width={nodeTableW}
        >
          <Box flexDirection="row">
            <Text color={TEXT.dim}>{"SHORT ".padEnd(7)}</Text>
            <Text color={TEXT.dim}>{"LONG NAME            ".padEnd(22)}</Text>
            <Text color={TEXT.dim}>{"SNR  ".padEnd(6)}</Text>
            <Text color={TEXT.dim}>{"HPS".padEnd(4)}</Text>
            <Text color={TEXT.dim}>{"BAT  ".padEnd(6)}</Text>
            <Text color={TEXT.dim}>HEARD</Text>
          </Box>
          {hiddenAbove > 0 && (
            <Text color={TEXT.dim}>  ↑{hiddenAbove} above</Text>
          )}
          {visibleNodes.map((n, i) => {
            const short = (n.short_name ?? "?").substring(0, 6).padEnd(6);
            const long = (n.long_name ?? n.id ?? "unknown").substring(0, 20).padEnd(21);
            const snr =
              n.snr != null ? n.snr.toFixed(1).padStart(5) : "    —";
            const hops =
              n.hops_away != null ? String(n.hops_away).padStart(3) : "  —";
            const bat =
              n.battery_pct != null ? `${n.battery_pct}%`.padStart(4) : "   —";
            const lh = fmtLastHeard(n.last_heard);
            return (
              <Box key={i} flexDirection="row">
                <Text color={COLORS.cyan}>{short} </Text>
                <Text color={TEXT.hi}>{long} </Text>
                <Text color={n.snr != null && n.snr > 0 ? TEXT.body : TEXT.dim}>
                  {snr}{" "}
                </Text>
                <Text color={TEXT.dim}>{hops} </Text>
                <Text
                  color={
                    n.battery_pct != null && n.battery_pct < 20
                      ? "#ef4444"
                      : TEXT.dim
                  }
                >
                  {bat}{" "}
                </Text>
                <Text color={TEXT.dim}>{lh}</Text>
              </Box>
            );
          })}
          {hiddenBelow > 0 && (
            <Text color={TEXT.dim}>  +{hiddenBelow} more  ↑/↓ scroll</Text>
          )}
          {nodeCount === 0 && (
            <Text color={TEXT.dim}>  no nodes discovered</Text>
          )}
        </Tile>

        {/* ── send form ── */}
        <Tile title="SEND MESSAGE" led="violet" width={sendFormW}>
          <Text color={TEXT.dim}>  ch 0 → all nodes</Text>
          <Box marginTop={1} paddingX={1}>
            <TextInput
              value={msg}
              onChange={setMsg}
              onSubmit={handleSend}
              placeholder="message…"
            />
          </Box>
          <Box marginTop={1}>
            {sending ? (
              <Text color={COLORS.amber}>  sending…</Text>
            ) : sendResult ? (
              <Text
                color={
                  sendResult.startsWith("✓") ? COLORS.mint : "#ef4444"
                }
              >
                {"  "}{sendResult}
              </Text>
            ) : (
              <Text color={TEXT.dim}>  ↵ to send</Text>
            )}
          </Box>
        </Tile>
      </Box>
    </Box>
  );
}
