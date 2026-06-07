// ============================================================================
// Markdown — a small, Ink-native renderer for the assistant's answers.
//
// The model emits Markdown; raw `**bold**` and `|---|` pipe tables are the
// worst eyesore. We DON'T pull a heavy/DOM-oriented renderer (marked-terminal
// emits ANSI strings; ink-markdown is stale) — we hand-roll the common cases
// the model actually produces: headings, **bold** / `code`, bullet + numbered
// lists, and pipe tables.
//
// TABLES (load-bearing): each row is emitted as ONE space-padded <Text>, never
// nested <Box width> cells — Yoga would re-flow the cells and break alignment
// (and this renders into <Static>, where a garbled table is permanent in
// scrollback). Columns are padded to a fixed width and overflow is truncated
// with “…”, capped to the available width.
// ============================================================================

import { Box, Text } from "ink";
import { COLORS, TEXT } from "../lib/theme.js";

export interface FormattedTable {
  header: string;
  separator: string;
  rows: string[];
}

// Pure + unit-tested: pad a markdown table into aligned monospace lines.
export function formatTable(headers: string[], bodyRows: string[][], maxWidth = 80): FormattedTable {
  const ncols = Math.max(headers.length, ...bodyRows.map((r) => r.length), 1);
  const norm = (r: string[]) => Array.from({ length: ncols }, (_, i) => (r[i] ?? "").trim());
  const H = norm(headers);
  const R = bodyRows.map(norm);

  const widths = Array.from({ length: ncols }, (_, i) =>
    Math.max(1, H[i].length, ...R.map((r) => r[i].length)),
  );

  // Cap total width (cells + " │ " separators) to maxWidth by shrinking the
  // widest column repeatedly (min 3 cols wide).
  const sepW = 3 * (ncols - 1);
  const budget = Math.max(ncols * 3, maxWidth - sepW);
  let guard = 4096;
  while (widths.reduce((a, b) => a + b, 0) > budget && guard-- > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 3) break;
    widths[widest]--;
  }

  const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s.padEnd(w));
  const join = (cells: string[]) => cells.map((c, i) => cell(c, widths[i])).join(" │ ");

  return {
    header: join(H),
    separator: widths.map((w) => "─".repeat(w)).join("─┼─"),
    rows: R.map(join),
  };
}

// ----- inline (**bold** / `code`) ----------------------------------------- //
interface Span {
  text: string;
  bold?: boolean;
  code?: boolean;
}

function parseInline(s: string): Span[] {
  const spans: Span[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) spans.push({ text: s.slice(last, m.index) });
    if (m[1] != null) spans.push({ text: m[1], bold: true });
    else if (m[2] != null) spans.push({ text: m[2], code: true });
    last = re.lastIndex;
  }
  if (last < s.length) spans.push({ text: s.slice(last) });
  return spans.length ? spans : [{ text: s }];
}

function Inline({ text, color }: { text: string; color: string }) {
  return (
    <>
      {parseInline(text).map((sp, i) => (
        <Text key={i} bold={sp.bold} color={sp.code ? COLORS.cyan : color}>
          {sp.text}
        </Text>
      ))}
    </>
  );
}

// ----- blocks -------------------------------------------------------------- //
type Block =
  | { type: "blank" }
  | { type: "heading"; text: string }
  | { type: "ul"; text: string }
  | { type: "ol"; marker: string; text: string }
  | { type: "table"; table: FormattedTable }
  | { type: "para"; text: string };

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function parseBlocks(src: string, maxWidth: number): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  const pushBlank = () => {
    if (blocks.length && blocks[blocks.length - 1].type === "blank") return; // collapse
    blocks.push({ type: "blank" });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") {
      pushBlank();
      continue;
    }
    // Pipe table: a header row immediately followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const headers = splitCells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        body.push(splitCells(lines[i]));
        i++;
      }
      i--;
      blocks.push({ type: "table", table: formatTable(headers, body, maxWidth) });
      continue;
    }
    const h = t.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      blocks.push({ type: "heading", text: h[1] });
      continue;
    }
    const ul = t.match(/^[-*•]\s+(.*)$/);
    if (ul) {
      blocks.push({ type: "ul", text: ul[1] });
      continue;
    }
    const ol = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (ol) {
      blocks.push({ type: "ol", marker: ol[1], text: ol[2] });
      continue;
    }
    blocks.push({ type: "para", text: t });
  }
  return blocks;
}

function BlockView({ block, color }: { block: Block; color: string }) {
  switch (block.type) {
    case "blank":
      return <Text> </Text>;
    case "heading":
      return (
        <Text bold color={COLORS.cyan}>
          {block.text}
        </Text>
      );
    case "ul":
      return (
        <Text color={color}>
          {"  "}
          <Text color={COLORS.violet}>•</Text>
          {" "}
          <Inline text={block.text} color={color} />
        </Text>
      );
    case "ol":
      return (
        <Text color={color}>
          {"  "}
          <Text color={COLORS.violet}>{block.marker}.</Text>
          {" "}
          <Inline text={block.text} color={color} />
        </Text>
      );
    case "table":
      return (
        <Box flexDirection="column">
          <Text color={COLORS.cyan} wrap="truncate-end">
            {block.table.header}
          </Text>
          <Text color={TEXT.dim} wrap="truncate-end">
            {block.table.separator}
          </Text>
          {block.table.rows.map((r, i) => (
            <Text key={i} color={color} wrap="truncate-end">
              {r}
            </Text>
          ))}
        </Box>
      );
    case "para":
      return (
        <Text color={color} wrap="wrap">
          <Inline text={block.text} color={color} />
        </Text>
      );
  }
}

export function Markdown({
  children,
  width = 80,
  color = TEXT.body,
}: {
  children: string;
  width?: number;
  color?: string;
}) {
  const blocks = parseBlocks((children ?? "").trim(), Math.max(20, width));
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} color={color} />
      ))}
    </Box>
  );
}
