// Audio Devices — Ink TUI screen.
// Mirrors web/src/components/AudioSettings.tsx.
// Polls GET /api/audio/devices → sinks + sources (PipeWire/wpctl frontend).
// Keys: 1/2 switch view, j/k move cursor, d set-default, m mute, t test (sinks),
//       +/- adjust volume ±10%. Actions POST immediately and trigger a refetch.

import { Box, Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

type AudioDevice = {
  id: number;
  name: string;
  default: boolean;
  volume: number; // 0.0 – 1.5
  muted: boolean;
};

type AudioDevices = {
  ok: boolean;
  sinks: AudioDevice[];
  sources: AudioDevice[];
};

function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

function volLed(dev: AudioDevice): LEDColor {
  if (dev.muted) return "dim";
  if (dev.volume > 1.0) return "pink";
  if (dev.volume > 0) return "mint";
  return "dim";
}

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const tileW = Math.min((stdout?.columns ?? 120) - 2, 116);
  const [view, setView] = useState<"sinks" | "sources">("sinks");
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const { data, error } = usePoll<AudioDevices>(
    () => api.get<AudioDevices>("/api/audio/devices"),
    3000,
    [api, tick],
  );

  const devices: AudioDevice[] = data ? (view === "sinks" ? data.sinks : data.sources) : [];
  const sel: AudioDevice | null = devices[cursor] ?? null;

  // Live refs — prevent stale closure in useInput
  const devicesRef = useLive(devices);
  const selRef = useLive(sel);
  const viewRef = useLive(view);

  useInput((input, key) => {
    const listLen = devicesRef.current.length;
    const curSel = selRef.current;
    const curView = viewRef.current;

    if (key.upArrow || input === "k") {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor(c => Math.min(Math.max(0, listLen - 1), c + 1));
      return;
    }
    if (input === "1") { setView("sinks"); setCursor(0); setMsg(null); return; }
    if (input === "2") { setView("sources"); setCursor(0); setMsg(null); return; }

    if (!curSel) return;

    if (input === "d") {
      void api
        .post("/api/audio/default", { id: curSel.id })
        .then(() => { setTick(t => t + 1); setMsg(`Default → ${curSel.name}`); })
        .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
    } else if (input === "m") {
      void api
        .post("/api/audio/mute", { id: curSel.id, muted: !curSel.muted })
        .then(() => { setTick(t => t + 1); setMsg(curSel.muted ? "Unmuted" : "Muted"); })
        .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
    } else if (input === "t" && curView === "sinks") {
      void api
        .post("/api/audio/test", { id: curSel.id })
        .then(() => setMsg(`Test tone → ${curSel.name}`))
        .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
    } else if (input === "+") {
      const vol = Math.round(Math.min(1.5, curSel.volume + 0.1) * 10) / 10;
      void api
        .post("/api/audio/volume", { id: curSel.id, volume: vol })
        .then(() => setTick(t => t + 1))
        .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
    } else if (input === "-") {
      const vol = Math.round(Math.max(0, curSel.volume - 0.1) * 10) / 10;
      void api
        .post("/api/audio/volume", { id: curSel.id, volume: vol })
        .then(() => setTick(t => t + 1))
        .catch((e: unknown) => setMsg(`ERR: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="13 AUDIO" title="Audio Devices" state="LINK ERROR" icon="♪" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>audio error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  const sinkCount = data?.sinks.length ?? 0;
  const srcCount = data?.sources.length ?? 0;

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="13 AUDIO"
        title="Audio Devices"
        state={data ? "LIVE" : "ACQUIRING"}
        icon="♪"
        right={
          data ? (
            <Text color={TEXT.dim}>
              {sinkCount} sinks · {srcCount} sources
            </Text>
          ) : undefined
        }
      />

      {/* View selector */}
      <Box>
        <Text color={TEXT.dim}> </Text>
        <Text color={view === "sinks" ? COLORS.amber : TEXT.dim} bold={view === "sinks"}>
          [1] SINKS
        </Text>
        <Text color={TEXT.dim}>  │  </Text>
        <Text color={view === "sources" ? COLORS.amber : TEXT.dim} bold={view === "sources"}>
          [2] SOURCES
        </Text>
      </Box>

      {/* Device list */}
      <Tile
        title={view === "sinks" ? "OUTPUT SINKS" : "INPUT SOURCES"}
        led={data ? (devices.length > 0 ? "mint" : "amber") : "dim"}
        width={tileW}
      >
        {!data ? (
          <Text color={TEXT.dim}>acquiring devices…</Text>
        ) : devices.length === 0 ? (
          <Text color={TEXT.dim}>no {view} found</Text>
        ) : (
          devices.map(dev => {
            const isSel = dev.id === sel?.id;
            const led = volLed(dev);
            const volPct = Math.round(dev.volume * 100);
            return (
              <Box key={dev.id}>
                <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                <Text color={dev.default ? COLORS.mint : TEXT.dim}>
                  {dev.default ? "DEF" : "   "}
                </Text>
                <Text color={TEXT.dim}> </Text>
                <Text color={isSel ? COLORS.amber : TEXT.body} wrap="truncate-end">
                  {dev.name.slice(0, 52).padEnd(52)}
                </Text>
                <Text color={TEXT.dim}> vol:</Text>
                <Text color={COLORS[led]}>{String(volPct).padStart(4)}%</Text>
                <Text color={TEXT.dim}> </Text>
                <StatusLED color={led} />
                <Text color={TEXT.dim}> {dev.muted ? "MUTE" : "LIVE"}</Text>
              </Box>
            );
          })
        )}
      </Tile>

      {/* Help bar */}
      <Box>
        <Text color={TEXT.dim}>
          j/k:move  d:default  m:mute  +:vol+  -:vol-{view === "sinks" ? "  t:test" : ""}
        </Text>
        {msg ? <Text color={COLORS.amber}>  › {msg}</Text> : null}
      </Box>
    </Box>
  );
}
