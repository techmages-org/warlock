// Markdown renderer tests — the pure table formatter (alignment + truncation)
// and the Ink component (bold/lists/tables render, not raw markup).

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { formatTable, Markdown } from "./Markdown.js";

describe("formatTable", () => {
  it("pads columns so every row is the same width (aligned)", () => {
    const t = formatTable(["A", "BB"], [["1", "222"], ["xx", "y"]], 80);
    const lines = [t.header, t.separator, ...t.rows];
    const lens = new Set(lines.map((l) => [...l].length));
    expect(lens.size).toBe(1); // all rows identical width → aligned
    expect(t.header).toContain("A");
    expect(t.header).toContain("BB");
    expect(t.header).toContain("│");
    expect(t.separator).toContain("┼");
  });

  it("truncates overflowing cells with an ellipsis and respects maxWidth", () => {
    const t = formatTable(["x"], [["abcdefghij"]], 6);
    expect([...t.rows[0]].length).toBeLessThanOrEqual(6);
    expect(t.rows[0]).toContain("…");
    expect(t.rows[0].startsWith("abc")).toBe(true);
  });
});

describe("Markdown component", () => {
  it("renders **bold** without the asterisks", () => {
    const { lastFrame, unmount } = render(<Markdown>{"This is **important** now"}</Markdown>);
    const frame = lastFrame()!;
    expect(frame).toContain("important");
    expect(frame).not.toContain("**");
    unmount();
  });

  it("renders bullet and numbered lists with markers, not raw dashes", () => {
    const { lastFrame, unmount } = render(<Markdown>{"- first\n- second\n\n1. one\n2. two"}</Markdown>);
    const frame = lastFrame()!;
    expect(frame).toContain("• first");
    expect(frame).toContain("• second");
    expect(frame).toContain("1. one");
    expect(frame).toContain("2. two");
    unmount();
  });

  it("renders a pipe table aligned, without raw |---| markup", () => {
    const md = "| Tool | State |\n|------|-------|\n| sdr | idle |\n| mesh | up |";
    const { lastFrame, unmount } = render(<Markdown width={60}>{md}</Markdown>);
    const frame = lastFrame()!;
    expect(frame).toContain("Tool");
    expect(frame).toContain("State");
    expect(frame).toContain("sdr");
    expect(frame).toContain("mesh");
    expect(frame).not.toContain("|------|"); // raw separator gone
    expect(frame).not.toContain("| sdr |"); // raw pipe row gone
    expect(frame).toContain("│"); // rendered box separator present
    unmount();
  });
});
