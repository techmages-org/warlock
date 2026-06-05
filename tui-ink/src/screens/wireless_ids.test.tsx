// Wireless IDS screen render tests — co-located with the screen per the W2 contract.
// Mock the API client so no real network is needed. Cover:
//   1. loaded state — assert key labels and live data values appear
//   2. error state  — assert LINK ERROR tile shows when both endpoints fail

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as WirelessIds } from "./wireless_ids.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const STATUS_FIXTURE = {
  ok: true,
  running: true,
  iface: "mon0",
  channels: "all",
  kismet_reachable: true,
  uptime_s: 125,
  started_at: "2026-06-05T12:00:00",
  allowlist: { ssids: 3, bssids: 1 },
};

const DET_FIXTURE = {
  ok: true,
  running: true,
  count: 2,
  counts: { rogue_ap: 1, evil_twin: 1, deauth_flood: 0, kismet_alert: 0 },
  detections: [
    {
      type: "evil_twin" as const,
      severity: "high" as const,
      bssid: "aa:bb:cc:dd:ee:ff",
      ssid: "CorpNet",
      channel: 6,
      signal: -55,
      detail: "Allowlisted SSID seen on unrecognized BSSID",
      first_seen: "2026-06-05T12:00:01",
      last_seen: "2026-06-05T12:02:00",
      source: "analysis",
    },
    {
      type: "rogue_ap" as const,
      severity: "medium" as const,
      bssid: "11:22:33:44:55:66",
      ssid: "FreeWiFi",
      channel: 1,
      signal: -70,
      detail: "AP broadcasting unlisted SSID 'FreeWiFi'",
      first_seen: "2026-06-05T12:00:10",
      last_seen: "2026-06-05T12:01:50",
      source: "analysis",
    },
  ],
  errors: [],
};

// ─── Mock context factory ──────────────────────────────────────────────────

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/wireless_ids/status")) return STATUS_FIXTURE as unknown;
      if (path.includes("/api/wireless_ids/detections")) return DET_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("WirelessIds screen", () => {
  it("renders live IDS data after the polled load resolves", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <WirelessIds />
      </WarlockProvider>,
    );

    // Waits for both polls to resolve and data to appear
    await vi.waitFor(() => expect(lastFrame()).toContain("MONITORING"));

    const frame = lastFrame()!;
    expect(frame).toContain("14 BLUE-IDS");
    expect(frame).toContain("Wireless IDS");
    expect(frame).toContain("STATE");
    expect(frame).toContain("KISMET");
    expect(frame).toContain("THREATS");
    expect(frame).toContain("mon0");            // iface from status fixture
    expect(frame).toContain("2 detections");    // count from det fixture
    expect(frame).toContain("EVIL-TWIN");       // detection type label
    expect(frame).toContain("CorpNet");         // ssid from detection
    expect(frame).toContain("3 SSID");          // allowlist counts

    unmount();
  });

  it("shows LINK ERROR tile when both endpoints fail", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));

    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <WirelessIds />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("wireless_ids error");

    unmount();
  });
});
