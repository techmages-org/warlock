// Top + bottom HUD strips — Ink analogues of the web HudBar.
//
// HudBarTop: one line — WARLOCK ◉ · hostname · version · clock · SVC/NTP/GPS/MSH LEDs.
//   Polls /api/version once and /api/dashboard/status every 2s for the LED states.
// HudBarBottom: one line of hotkey hints (the g+<key> nav legend + ? help).

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useApi } from "../context.js";
import { COLORS, TEXT } from "../lib/theme.js";
import type { DashboardStatus, Version } from "../lib/types.js";
import { StatusLED } from "./StatusLED.js";

function clock(now: Date): string {
  return now.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function HudBarTop() {
  const api = useApi();
  const [version, setVersion] = useState<Version | null>(null);
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    api.get<Version>("/api/version").then(setVersion).catch(() => setVersion(null));
  }, [api]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<DashboardStatus>("/api/dashboard/status");
        if (alive) setStatus(r);
      } catch {
        /* strip shows stale */
      }
    };
    load();
    const t = setInterval(load, 2000);
    const c = setInterval(() => setNow(new Date()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(c);
    };
  }, [api]);

  const led = (ok: boolean | undefined): "mint" | "amber" => (ok ? "mint" : "amber");
  const hostname = status?.hostname ?? "warlock";
  const versionLabel = version ? `v${version.version}` : "v—";
  const chronyOk = status?.chrony?.ok;
  const gpsOk = !!status?.gps?.ok && (status?.gps?.mode ?? 0) >= 2;
  const meshOk = status?.mesh_node_count != null;

  return (
    <Box justifyContent="space-between">
      <Box>
        <Text bold color={COLORS.amber}>
          ◉ WARLOCK
        </Text>
        <Text color={TEXT.dim}> ▪ </Text>
        <Text color={TEXT.body}>{hostname}</Text>
        <Text color={TEXT.dim}> ▪ </Text>
        <Text color={TEXT.dim}>{versionLabel}</Text>
        <Text color={TEXT.dim}> ▪ </Text>
        <Text color={TEXT.hi}>{clock(now)}</Text>
      </Box>
      <Box>
        <StatusLED color="mint" />
        <Text color={TEXT.dim}> SVC </Text>
        <StatusLED color={led(chronyOk)} />
        <Text color={TEXT.dim}> NTP </Text>
        <StatusLED color={led(gpsOk)} />
        <Text color={TEXT.dim}> GPS </Text>
        <StatusLED color={led(meshOk)} />
        <Text color={TEXT.dim}> MSH</Text>
      </Box>
    </Box>
  );
}

export function HudBarBottom() {
  const hint = (key: string, label: string) => (
    <>
      <Text color={COLORS.violet}>[{key}]</Text>
      <Text color={TEXT.dim}> {label}  </Text>
    </>
  );
  return (
    <Box>
      {hint("g d", "dash")}
      {hint("g w", "wifi")}
      {hint("g s", "sdr")}
      {hint("g e", "ops")}
      {hint("^K", "kill")}
      {hint("?", "help")}
      {hint("q", "quit")}
    </Box>
  );
}
