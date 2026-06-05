// SDR Offensive screen tests — engagement gate + module status.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as SdrOffensive } from "./sdr_offensive.js";

const FIXTURE_MOD_STATUS = {
  module: "sdr_offensive",
  label: "Offensive SDR",
  status: "pending",
  requires_engagement: true,
  todo: [
    "Replay file preparation (RTL-SDR is RX-only; requires HackRF for TX)",
    "Signal analysis for garage/TPMS/433MHz captures",
    "Hook points for HackRF/LimeSDR when hardware arrives",
  ],
};

const ENG_OFF = {
  mode: "off",
  engagement_id: null,
  name: "",
  scope: { ssids: [], bssids: [], ip_ranges: [] },
  started_at: null,
};

const ENG_ON = {
  mode: "on",
  engagement_id: "eng-001",
  name: "Test Op",
  scope: { ssids: ["TestNet"], bssids: [], ip_ranges: [] },
  started_at: "2026-06-05T14:00:00",
};

function mockContext(engOverride?: unknown): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/engagements/active"))
        return (engOverride ?? ENG_OFF) as unknown;
      if (path.includes("/api/sdr_offensive/status"))
        return FIXTURE_MOD_STATUS as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("SDR Offensive screen", () => {
  it("shows engagement gate when no engagement is active", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENG_OFF)}>
        <SdrOffensive />
      </WarlockProvider>,
    );

    // Wait for the gate tile — only appears when eng.mode === "off" is loaded
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGEMENT REQUIRED"));

    const frame = lastFrame()!;
    expect(frame).toContain("SDR-OFF");
    // Capability roadmap always shown
    expect(frame).toContain("CAPABILITY ROADMAP");
    unmount();
  });

  it("shows capability roadmap with TODO items", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENG_OFF)}>
        <SdrOffensive />
      </WarlockProvider>,
    );

    // Wait for TODO content to load (HackRF only appears when modStatus resolves)
    await vi.waitFor(() => expect(lastFrame()).toContain("HackRF"));

    const frame = lastFrame()!;
    expect(frame).toContain("RTL-SDR is RX-only");
    unmount();
  });

  it("shows module status when engagement is on", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENG_ON)}>
        <SdrOffensive />
      </WarlockProvider>,
    );

    // Wait for MODULE STATUS — only rendered when engaged
    await vi.waitFor(() => expect(lastFrame()).toContain("MODULE STATUS"));

    const frame = lastFrame()!;
    expect(frame).toContain("SDR-OFF");
    expect(frame).toContain("CAPABILITY ROADMAP");
    unmount();
  });

  it("shows loading state initially", () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(() => new Promise(() => {})),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = {
      config: { apiUrl: "http://test", auth: null },
      api,
      bus,
    };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("SDR-OFF");
    unmount();
  });

  it("caps todo list and shows +N more at narrow terminal height", async () => {
    // 10 todo items at rows=24 fallback → maxTodo = max(1, 24-17) = 7 → "+3 more"
    const manyTodos = Array.from(
      { length: 10 },
      (_, i) => `Todo item ${i + 1} — placeholder roadmap entry`,
    );
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/engagements/active")) return ENG_OFF as unknown;
        if (path.includes("/api/sdr_offensive/status"))
          return {
            module: "sdr_offensive",
            label: "Offensive SDR",
            status: "pending",
            requires_engagement: true,
            todo: manyTodos,
          } as unknown;
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    // "Todo item 1" only appears in loaded state
    await vi.waitFor(() => expect(lastFrame()).toContain("Todo item 1"));
    await vi.waitFor(() => expect(lastFrame()).toMatch(/\+\d+ more/));
    unmount();
  });
});
