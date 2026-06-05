// Engagement state band — Ink analogue of the web EngagementBanner. One line
// (low-height geometry). Polls /api/engagements/active every 2s AND refreshes
// on engagement.* / killswitch.pressed bus events. Renders:
//   loading → "◎ acquiring engagement state…" (amber)
//   off     → "◎ SAFE MODE — passive instruments only" (mint)
//   on      → "▶▶▶ ENGAGED :: <name> :: T+<elapsed> :: SCOPE n" (pink)

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useApi, useBus } from "../context.js";
import { COLORS, TEXT } from "../lib/theme.js";
import type { EngagementStatus } from "../lib/types.js";

function elapsedSince(iso: string | null, nowMs: number): string {
  if (!iso) return "0:00";
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return "0:00";
  const d = Math.max(0, (nowMs - start) / 1000);
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  const s = Math.floor(d % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

const LOADING: EngagementStatus = {
  mode: "loading",
  engagement_id: null,
  name: "",
  scope: { ssids: [], bssids: [], ip_ranges: [] },
  started_at: null,
};

export function EngagementBanner() {
  const api = useApi();
  const bus = useBus();
  const [status, setStatus] = useState<EngagementStatus>(LOADING);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const s = await api.get<EngagementStatus>("/api/engagements/active");
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus((p) => ({ ...p, mode: "loading" }));
      }
    };
    refresh();
    const t = setInterval(refresh, 2000);
    const unsub = bus.subscribe((e) => {
      if (e.name.startsWith("engagement.") || e.name === "killswitch.pressed") refresh();
    });
    return () => {
      alive = false;
      clearInterval(t);
      unsub();
    };
  }, [api, bus]);

  // Tick the elapsed clock once a second without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (status.mode === "loading") {
    return (
      <Box>
        <Text color={COLORS.amber}>◎ acquiring engagement state…</Text>
      </Box>
    );
  }

  if (status.mode === "off") {
    return (
      <Box justifyContent="space-between">
        <Text color={COLORS.mint}>◎ SAFE MODE — passive instruments only</Text>
        <Text color={TEXT.dim}>no engagement active</Text>
      </Box>
    );
  }

  const scopeCount =
    status.scope.ssids.length + status.scope.bssids.length + status.scope.ip_ranges.length;
  return (
    <Box>
      <Text bold color={COLORS.pink}>
        ▶▶▶ ENGAGED
      </Text>
      <Text color={TEXT.dim}> :: </Text>
      <Text color={COLORS.amber}>{status.name || status.engagement_id || "unnamed"}</Text>
      <Text color={TEXT.dim}> :: </Text>
      <Text color={TEXT.hi}>T+{elapsedSince(status.started_at, nowMs)}</Text>
      <Text color={TEXT.dim}> :: </Text>
      <Text color={TEXT.body}>
        SCOPE {scopeCount} target{scopeCount === 1 ? "" : "s"}
      </Text>
      <Text color={TEXT.dim}> — Ctrl+K KILL</Text>
    </Box>
  );
}
