// Report screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./report.js";

const LIST_FIXTURE = {
  ok: true,
  count: 2,
  reports: [
    { id: "rpt-1749500000", mtime: 1749500000 },
    { id: "rpt-1749400000", mtime: 1749400000 },
  ],
};

const GEN_FIXTURE = {
  ok: true,
  id: "rpt-1749510000",
  overall: "WARN",
  report: {
    report: "network-health",
    generated: "2026-06-09T22:00:00Z",
    deck: { hostname: "warlock", subject_did: null },
    summary: { overall: "WARN" },
    sections: {
      link: { verdict: "PASS" },
      reachability: { verdict: "WARN" },
      services: { verdict: "PASS" },
      wireless: { verdict: "INFO" },
    },
  },
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/report/list")) return LIST_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/api/report/generate")) return GEN_FIXTURE as unknown;
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Report screen", () => {
  it("renders the stored report list with the selected download path", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rpt-1749500000"));
    const frame = lastFrame()!;
    expect(frame).toContain("REPORTS (2)");
    expect(frame).toContain("rpt-1749400000");
    expect(frame).toContain("/api/report/download/rpt-1749500000");
    expect(frame).toContain("press g to generate");
    unmount();
  });

  it("moves the selection with j/k (download path follows)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rpt-1749500000"));
    stdin.write("j");
    await vi.waitFor(() =>
      expect(lastFrame()).toContain("/api/report/download/rpt-1749400000"),
    );
    unmount();
  });

  it("generates a report on 'g' and renders overall + section verdicts", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rpt-1749500000"));
    stdin.write("g");
    await vi.waitFor(() => expect(lastFrame()).toContain("rpt-1749510000"));
    const frame = lastFrame()!;
    expect(frame).toContain("WARN");
    expect(frame).toContain("reachability");
    expect(frame).toContain("wireless");
    expect(frame).toContain("INFO");
    expect(
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("/api/report/generate"),
      ),
    ).toBe(true);
    unmount();
  });

  it("surfaces a generate failure without losing the screen", async () => {
    const ctx = mockContext();
    (ctx.api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("503: netdiag busy"));
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rpt-1749500000"));
    stdin.write("g");
    await vi.waitFor(() => expect(lastFrame()).toContain("generate failed"));
    expect(lastFrame()).toContain("503: netdiag busy");
    unmount();
  });

  it("shows LINK ERROR when the list endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("report offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("report error");
    unmount();
  });
});
