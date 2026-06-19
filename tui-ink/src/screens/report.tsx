// Report — Ink TUI screen. Module id: report.
// One-button Site-Survey / Network-Health report (Track A4):
//   g → POST /api/report/generate (runs the full diagnostic suite)
//   list of recent reports from GET /api/report/list, j/k to select,
//   download path shown for the selected report (print-to-PDF in a browser).

import { Box, Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

// ── Types (mirror src/warlock/modules/report.py responses) ───────────────────

type RepItem = { id: string; mtime: number };

type ListResp = { ok: boolean; count: number; reports: RepItem[] };

type Section = { verdict?: string } & Record<string, unknown>;

type GenResp = {
  ok: boolean;
  id: string;
  overall: string;
  report: {
    generated: string;
    summary: { overall: string };
    sections: Record<string, Section>;
  };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const LIST_CAP = 8;

function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number; more: number } {
  if (items.length <= cap) return { slice: items, start: 0, more: 0 };
  const start = Math.max(0, Math.min(sel - Math.floor(cap / 2), items.length - cap));
  return { slice: items.slice(start, start + cap), start, more: items.length - start - cap };
}

function verdictColor(v: string): string {
  if (v === "PASS") return COLORS.mint;
  if (v === "WARN") return COLORS.amber;
  if (v === "FAIL") return COLORS.pink;
  if (v === "INFO") return COLORS.violet;
  return TEXT.dim;
}

function verdictLed(v: string | null | undefined): LEDColor {
  if (v === "PASS") return "mint";
  if (v === "WARN") return "amber";
  if (v === "FAIL") return "pink";
  if (v === "INFO") return "violet";
  return "dim";
}

function fmtMtime(mtime: number): string {
  return new Date(mtime * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

// ── Screen ───────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;

  const [sel, setSel] = useState(0);
  const [tick, setTick] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [gen, setGen] = useState<GenResp | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);

  const { data: list, error: listError } = usePoll<ListResp>(
    () => api.get<ListResp>("/api/report/list"),
    5000,
    [api, tick],
  );

  const reports = list?.reports ?? [];
  const reportsRef = useLive(reports);
  const generatingRef = useLive(generating);

  const generate = async () => {
    setGenerating(true);
    setGenErr(null);
    try {
      const r = await api.post<GenResp>("/api/report/generate", {});
      setGen(r);
      setTick((t) => t + 1);
      setSel(0);
    } catch (e: unknown) {
      setGenErr(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  useInput((input, key) => {
    const n = reportsRef.current.length;
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === "j") setSel((s) => Math.min(Math.max(0, n - 1), s + 1));
    else if (input === "g" && !generatingRef.current) void generate();
  });

  // ── Error state ──────────────────────────────────────────────────────────
  if (listError && !list) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="13 RPT" title="Report" state="LINK ERROR" icon="▤" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>report error: {listError}</Text>
        </Tile>
      </Box>
    );
  }

  const listW = Math.min(46, Math.max(34, Math.floor((cols - 4) / 2)));
  const genW = Math.min(68, cols - 4 - listW - 1);
  const selClamped = Math.min(sel, Math.max(0, reports.length - 1));
  const win = windowOf(reports, selClamped, LIST_CAP);
  const selected = reports[selClamped];

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="13 RPT"
        title="Report"
        state={generating ? "GENERATING" : list ? `${list.count} stored` : "ACQUIRING"}
        icon="▤"
      />

      <Box flexDirection="row" gap={1}>
        {/* Recent reports */}
        <Tile title={`REPORTS (${reports.length})`} led={reports.length > 0 ? "violet" : "dim"} width={listW}>
          {!list ? (
            <Text color={TEXT.dim}>loading reports…</Text>
          ) : reports.length === 0 ? (
            <Text color={TEXT.dim}>no reports yet — press g</Text>
          ) : (
            <>
              {win.slice.map((r, i) => {
                const idx = win.start + i;
                const isSel = idx === selClamped;
                return (
                  <Box key={r.id}>
                    <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                    <Text color={isSel ? COLORS.amber : TEXT.body}>{r.id.padEnd(16)}</Text>
                    <Text color={TEXT.dim}>{fmtMtime(r.mtime)}</Text>
                  </Box>
                );
              })}
              {win.more > 0 ? <Text color={TEXT.dim}>  +{win.more} more</Text> : null}
            </>
          )}
        </Tile>

        {/* Last generated */}
        <Tile
          title="LAST GENERATED"
          led={generating ? "amber" : verdictLed(gen?.overall)}
          width={genW}
          headerRight={
            gen && !generating ? (
              <Text color={verdictColor(gen.overall)} bold>
                {gen.overall}{" "}
              </Text>
            ) : undefined
          }
        >
          {generating ? (
            <Text color={COLORS.amber}>generating… (runs the full diagnostic suite)</Text>
          ) : genErr ? (
            <Text color={COLORS.pink}>generate failed: {genErr}</Text>
          ) : !gen ? (
            <Text color={TEXT.dim}>press g to generate a network-health report</Text>
          ) : (
            <>
              <Box>
                <Text color={TEXT.dim}>id </Text>
                <Text color={TEXT.hi}>{gen.id}</Text>
                <Text color={TEXT.dim}>  {gen.report.generated}</Text>
              </Box>
              {Object.entries(gen.report.sections).map(([name, sec]) => {
                const v = sec.verdict ?? "unknown";
                return (
                  <Box key={name}>
                    <Text color={TEXT.body}>{name.padEnd(14)}</Text>
                    <Text color={verdictColor(v)} bold>
                      {v}
                    </Text>
                  </Box>
                );
              })}
            </>
          )}
        </Tile>
      </Box>

      {/* Selected report download path (print-to-PDF in a browser) */}
      {selected ? (
        <Text color={TEXT.dim} wrap="truncate-end">
          {" "}DL: {api.baseUrl}/api/report/download/{selected.id}
        </Text>
      ) : null}

      {/* Help bar */}
      <Box>
        <Text color={TEXT.dim}>g:generate  j/k:select</Text>
        {generating ? <Text color={COLORS.amber}>  › generating…</Text> : null}
      </Box>
    </Box>
  );
}
