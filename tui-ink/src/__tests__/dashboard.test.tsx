// Dashboard render test — the canonical "prove a screen without a TTY" pattern
// every worker copies. Mock the API client, wrap the screen in WarlockProvider,
// AWAIT the polled load (Dashboard shows "acquiring…" first), then assert the
// live frame. unmount() so the 2s poll interval doesn't keep vitest alive.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import type { DashboardStatus } from "../lib/types.js";
import { Screen as Dashboard } from "../screens/dashboard.js";

const FIXTURE: DashboardStatus = {
  hostname: "warlock",
  now: "2026-06-05T17:16:42",
  cpu: { load_1m: 0.52, load_5m: 0.14, load_15m: 0.08, count: 4, percent: 1.5 },
  memory: { total_mb: 8062.9, available_mb: 7206.6, percent: 10.6 },
  temp_c: 59.0,
  temp_f: 138.2,
  throttled: "throttled=0x0",
  disk_root_mb_free: 3530456.0,
  disk_root_percent: 0.9,
  rtc_drift_s: null,
  chrony: { ok: true, stratum: 5, offset_s: 0.000076686, source: "X" },
  gps: { ok: true, mode: 1 },
  nmcli_active: [{ name: "Wired", device: "eth0", state: "activated", type: "802-3-ethernet" }],
  mesh_node_count: 55,
  sdr: { ok: true, count: 1 },
  engagement: {
    mode: "off",
    engagement_id: null,
    name: "",
    scope: { ssids: [], bssids: [], ip_ranges: [] },
    started_at: null,
  },
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/dashboard/status")) return FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Dashboard screen", () => {
  it("renders live telemetry after the polled load resolves", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Dashboard />
      </WarlockProvider>,
    );

    // First frame is the "acquiring telemetry…" boot state; wait for the fetch.
    await vi.waitFor(() => expect(lastFrame()).toContain("warlock"));

    const frame = lastFrame()!;
    expect(frame).toContain("CPU LOAD");
    expect(frame).toContain("CORE TEMP");
    expect(frame).toContain("138.2"); // temp_f from the fixture
    expect(frame).toContain("MEMORY");
    expect(frame).toContain("PERIPHERALS");
    expect(frame).toContain("55 nodes"); // mesh_node_count roll-up

    unmount();
  });

  it("shows an error tile when the endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Dashboard />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("dashboard error");
    unmount();
  });
});
