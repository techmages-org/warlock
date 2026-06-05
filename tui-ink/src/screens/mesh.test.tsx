// Mesh screen tests — node table render + send form + error path.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as Mesh } from "./mesh.js";

const FIXTURE_NODES = [
  {
    id: "!aabb1122",
    num: 2864447778,
    long_name: "Warlock HQ",
    short_name: "WRLK",
    hw: "HELTEC_V3",
    last_heard: Math.floor(Date.now() / 1000) - 5,
    snr: 8.5,
    hops_away: 0,
    battery_pct: 92,
    lat: 30.7188,
    lon: -97.4436,
    alt: 261,
  },
  {
    id: "!ccdd3344",
    num: 3452816845,
    long_name: "Field Unit 2",
    short_name: "FU02",
    hw: "TBEAM",
    last_heard: Math.floor(Date.now() / 1000) - 120,
    snr: 4.25,
    hops_away: 1,
    battery_pct: 67,
    lat: 30.72,
    lon: -97.45,
    alt: 270,
  },
];

function mockContext(nodesOverride?: unknown): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/mesh/nodes"))
        return (nodesOverride ?? FIXTURE_NODES) as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Mesh screen", () => {
  it("renders node table after polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Mesh />
      </WarlockProvider>,
    );

    // WRLK (short_name from fixture) only appears in loaded state
    await vi.waitFor(() => expect(lastFrame()).toContain("WRLK"));

    const frame = lastFrame()!;
    expect(frame).toContain("MESH-TAC");
    expect(frame).toContain("MESH NODES");
    expect(frame).toContain("Warlock HQ");
    expect(frame).toContain("FU02");
    expect(frame).toContain("Field Unit 2");
    expect(frame).toContain("SEND MESSAGE");
    unmount();
  });

  it("shows node SNR and battery values", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Mesh />
      </WarlockProvider>,
    );
    // WRLK only appears in loaded state
    await vi.waitFor(() => expect(lastFrame()).toContain("WRLK"));
    const frame = lastFrame()!;
    expect(frame).toContain("8.5"); // snr
    expect(frame).toContain("92%"); // battery
    unmount();
  });

  it("renders send form", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Mesh />
      </WarlockProvider>,
    );
    // SEND MESSAGE only appears in loaded state
    await vi.waitFor(() => expect(lastFrame()).toContain("SEND MESSAGE"));
    expect(lastFrame()).toContain("MESH-TAC");
    unmount();
  });

  it("shows loading state before data resolves", () => {
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
        <Mesh />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("acquiring");
    unmount();
  });

  it("shows error tile when nodes endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("meshtasticd unreachable"),
    );
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Mesh />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("meshtasticd unreachable");
    unmount();
  });

  it("shows empty-state message when no nodes", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext([])}>
        <Mesh />
      </WarlockProvider>,
    );
    // "0 nodes" in the header only appears when empty array is loaded
    await vi.waitFor(() => expect(lastFrame()).toContain("0 nodes"));
    expect(lastFrame()).toContain("no nodes");
    unmount();
  });

  it("caps node list and shows +N more at narrow terminal height", async () => {
    // 25 nodes at rows=24 fallback → maxNodes = max(2, 24-7) = 17 → "+8 more"
    const manyNodes = Array.from({ length: 25 }, (_, i) => ({
      id: `!node${String(i).padStart(4, "0")}`,
      num: 1000000 + i,
      long_name: `Node ${i}`,
      short_name: `N${String(i).padStart(3, "0")}`,
      hw: "HELTEC_V3",
      last_heard: Math.floor(Date.now() / 1000) - i * 10,
      snr: 5 + (i % 10),
      hops_away: i % 3,
      battery_pct: 50 + (i % 50),
      lat: 30.7 + i * 0.01,
      lon: -97.4 - i * 0.01,
      alt: 260,
    }));
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/mesh/nodes")) return manyNodes as unknown;
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({ ok: true })),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Mesh />
      </WarlockProvider>,
    );
    // N000 short_name only appears in loaded state
    await vi.waitFor(() => expect(lastFrame()).toContain("N000"));
    await vi.waitFor(() => expect(lastFrame()).toMatch(/\+\d+ more/));
    unmount();
  });
});
