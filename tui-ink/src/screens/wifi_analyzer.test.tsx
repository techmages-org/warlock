// WiFi Analyzer screen test — mirrors wifi_recon.test.tsx: mock the api client,
// wrap in WarlockProvider, await the polled load, and assert the live frame for
// each of the three views (Channels / Survey / Locate) plus loading→loaded→error
// transitions, the record/reset/start/stop keybindings, and geometry (a long list
// is bounded to a scrolling window with a "+N more" indicator at 24x120).

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as WifiAnalyzer, geigerIntervalMs } from "./wifi_analyzer.js";

const CHANNELS = {
  ok: true,
  iface: "wlan0",
  channels: {
    "2.4": [
      { channel: 1, ap_count: 5, utilization_pct: 42.0 },
      { channel: 6, ap_count: 2, utilization_pct: null },
      { channel: 11, ap_count: 1, utilization_pct: 12.0 },
    ],
    "5": [{ channel: 149, ap_count: 1, utilization_pct: null }],
  },
  least_congested: { "2.4": 11, "5": 149 },
};

function walkSample(i: number, zone = "warm", rssi: number | null = -68) {
  return {
    ts: 1700000000 + i,
    label: `WP-${i + 1}`,
    target: "CorpWiFi",
    rssi_dbm: rssi,
    zone,
    bssid: "aa:bb:cc:dd:ee:ff",
    channel: 6,
    aps_visible: 9,
  };
}

const WALK = {
  ok: true,
  summary: { count: 2, zones: { warm: 1, dead: 1 }, dead_zones: 1, min_dbm: -88, max_dbm: -55, avg_dbm: -71.5 },
  samples: [walkSample(0, "warm", -55), walkSample(1, "dead", null)],
};

function scanAp(i: number) {
  return {
    bssid: `AA:BB:CC:DD:${String(i).padStart(2, "0")}:01`,
    associated: i === 0,
    ssid: `Net${i}`,
    freq_mhz: 2437,
    signal_dbm: -50 - i,
    channel: 6,
    band: "2.4",
    quality: "good",
  };
}

const LOCATE_INACTIVE = { ok: true, active: false };
const LOCATE_ACTIVE = {
  ok: true,
  active: true,
  bssid: "aa:bb:cc:dd:00:01",
  channel: 6,
  ssid: "Net0",
  peak_dbm: -42,
  rssi_dbm: -54,
  raw_dbm: -53,
  trend: "warmer",
  delta: 4,
  rate_hz: 9,
  samples: 12,
  proximity: "close",
  est_range_ft: 11,
  peak_ago_s: 3.2,
};

type Overrides = { scanCount?: number; locateActiveFromStart?: boolean };

function mockContext(o: Overrides = {}): WarlockContextValue {
  const scanCount = o.scanCount ?? 3;
  let locateRunning = !!o.locateActiveFromStart;
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/walk/trace")) return WALK as unknown;
      if (path.includes("/locate/sample")) return (locateRunning ? LOCATE_ACTIVE : LOCATE_INACTIVE) as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/channels")) return CHANNELS as unknown;
      if (path.includes("/scan"))
        return { ok: true, iface: "wlan0", count: scanCount, by_band: { "2.4": scanCount }, aps: Array.from({ length: scanCount }, (_, i) => scanAp(i)) } as unknown;
      if (path.includes("/walk/sample")) return { ok: true, sample: walkSample(2, "cold", -78) } as unknown;
      if (path.includes("/walk/reset")) return { ok: true, reset: true } as unknown;
      if (path.includes("/locate/start")) { locateRunning = true; return { ok: true, bssid: "aa:bb:cc:dd:00:01", channel: 6, ssid: "Net0" } as unknown; }
      if (path.includes("/locate/stop")) { locateRunning = false; return { ok: true, helper: "" } as unknown; }
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("WifiAnalyzer screen", () => {
  it("renders the channel congestion view after the polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    const frame = lastFrame()!;
    expect(frame).toContain("WiFi Analyzer");
    expect(frame).toContain("06 WIFI-ANL");
    expect(frame).toContain("2.4 GHz");
    expect(frame).toContain("least-congested → ch 11");
    expect(frame).toContain("42% busy");
    unmount();
  });

  it("shows a loading placeholder before the first channels load resolves", () => {
    const ctx = mockContext();
    // Never resolves → stays in the loading state.
    (ctx.api.post as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("scanning channels");
    unmount();
  });

  it("shows an error tile when the channels endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("iw scan failed"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("scan/survey error"));
    expect(lastFrame()).toContain("iw scan failed");
    unmount();
  });

  it("switches to the survey view and shows the dead-zone summary + samples", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("2"); // → Survey
    await vi.waitFor(() => expect(lastFrame()).toContain("WP-1")); // wait for walk/trace data
    const frame = lastFrame()!;
    expect(frame).toContain("WALK SAMPLES");
    expect(frame).toContain("DEAD 1");
    expect(frame).toContain("CorpWiFi");
    unmount();
  });

  it("records a waypoint from the survey view (auto label)", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("2");
    await vi.waitFor(() => expect(lastFrame()).toContain("WP-1")); // walk data loaded (count=2) → next auto label WP-3
    stdin.write("r"); // record
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/api/wifi_analyzer/walk/sample", { label: "WP-3" }));
    await vi.waitFor(() => expect(lastFrame()).toContain("recorded WP-3"));
    unmount();
  });

  it("resets the trace with shift-R", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("2");
    await vi.waitFor(() => expect(lastFrame()).toContain("WALK SAMPLES"));
    stdin.write("R"); // reset
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/api/wifi_analyzer/walk/reset"));
    await vi.waitFor(() => expect(lastFrame()).toContain("trace reset"));
    unmount();
  });

  it("scans for targets in the locate picker and starts a locate", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("3"); // → Locate (picker)
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:00:01")); // scan data loaded
    expect(lastFrame()).toContain("SELECT TARGET");
    stdin.write("\r"); // Enter → start locate on the selected (first) AP
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/api/wifi_analyzer/locate/start", { bssid: "AA:BB:CC:DD:00:01", channel: 6 }));
    await vi.waitFor(() => expect(lastFrame()).toContain("HOMING"));
    const frame = lastFrame()!;
    expect(frame).toContain("WARMER");
    expect(frame).toContain("CLOSE");
    expect(frame).toContain("indoors unreliable");
    expect(frame).toContain("peak");
    unmount();
  });

  it("resumes an already-running locate session on entering the view (re-entry probe)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext({ locateActiveFromStart: true })}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("3");
    await vi.waitFor(() => expect(lastFrame()).toContain("HOMING")); // meter, not picker
    unmount();
  });

  it("stops a locate session with x and returns to the picker", async () => {
    const ctx = mockContext({ locateActiveFromStart: true });
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("3");
    await vi.waitFor(() => expect(lastFrame()).toContain("HOMING"));
    stdin.write("x"); // stop
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/api/wifi_analyzer/locate/stop"));
    await vi.waitFor(() => expect(lastFrame()).toContain("SELECT TARGET"));
    unmount();
  });

  it("bounds a long target list to a scrolling window with +N more and fits 24 rows", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext({ scanCount: 40 })}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz")); // post-data: ensures input is subscribed
    stdin.write("3");
    await vi.waitFor(() => expect(lastFrame()).toContain("SELECT TARGET (40 APs)"));
    const frame = lastFrame()!;
    expect(frame).toMatch(/\+\d+ more/);
    expect(frame).toContain("/40)");
    const shown = (frame.match(/AA:BB:CC:DD:/g) ?? []).length;
    expect(shown).toBeLessThan(40);
    const lines = frame.split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    expect(lines.length).toBeLessThanOrEqual(20);
    unmount();
  });

  it("shows the geiger indicator (ON by default) and toggles mute with b", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext({ locateActiveFromStart: true })}>
        <WifiAnalyzer />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("2.4 GHz"));
    stdin.write("3"); // → Locate; re-entry probe resumes the live meter
    await vi.waitFor(() => expect(lastFrame()).toContain("HOMING"));
    // Geiger is ON by default — indicator shown, not muted.
    await vi.waitFor(() => expect(lastFrame()).toContain("♪ geiger"));
    expect(lastFrame()).not.toContain("muted");
    stdin.write("b"); // mute
    await vi.waitFor(() => expect(lastFrame()).toContain("✕ muted"));
    stdin.write("b"); // unmute
    await vi.waitFor(() => expect(lastFrame()).toContain("♪ geiger"));
    unmount();
  });
});

describe("geigerIntervalMs (homing cadence)", () => {
  it("maps signal strength to tick interval — stronger = faster", () => {
    expect(geigerIntervalMs(-90)).toBe(1300); // weak → slow blips
    expect(geigerIntervalMs(-35)).toBe(110); // strong → fast chatter
    // clamps beyond the window
    expect(geigerIntervalMs(-120)).toBe(1300);
    expect(geigerIntervalMs(-10)).toBe(110);
    // mid-range lands strictly between the bounds
    expect(geigerIntervalMs(-62)).toBeGreaterThan(110);
    expect(geigerIntervalMs(-62)).toBeLessThan(1300);
    // monotonic: a stronger signal always ticks at least as fast
    expect(geigerIntervalMs(-50)).toBeLessThan(geigerIntervalMs(-70));
  });
});
