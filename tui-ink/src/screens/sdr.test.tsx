// SDR screen tests — device status, ADS-B table, rtl_433 events.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as Sdr } from "./sdr.js";

const FIXTURE_STATUS = {
  ok: true,
  rtl_sdr_detected: true,
  tuner: "R820T2",
  device_count: 1,
  usb_present: true,
  blacklist: { present: true },
  readsb: { active: true },
  rtl_433: { active: false },
  lock: { holder: "readsb" },
};

const FIXTURE_AIRCRAFT = {
  ok: true,
  count: 2,
  aircraft: [
    {
      icao: "a12345",
      callsign: "UAL123",
      altitude_ft: 35000,
      speed_kt: 480,
      heading: 270,
      lat: 31.5,
      lon: -97.8,
      rssi: -18.5,
      seen_s: 0.2,
      squawk: "1200",
    },
    {
      icao: "b67890",
      callsign: "DAL456",
      altitude_ft: 28000,
      speed_kt: 380,
      heading: 180,
      lat: 29.9,
      lon: -98.1,
      rssi: -22.1,
      seen_s: 0.5,
      squawk: "2000",
    },
  ],
};

const FIXTURE_EVENTS = {
  ok: true,
  events: [
    { time: "2026-06-05T14:23:17", model: "LaCrosse-TX141THBv2", id: 42, temperature_C: 22.5, humidity: 65 },
    { time: "2026-06-05T14:23:12", model: "Hideki-TS04", id: 7, temperature_C: 21.0, humidity: 60 },
  ],
  running: false,
};

const FIXTURE_PRESETS = {
  ok: true,
  presets: [
    { id: "fm_bcast", label: "FM Broadcast", freq_mhz: 98.5, mode: "WFM", bw_khz: 200 },
    { id: "aviation_am", label: "Aviation AM", freq_mhz: 118.1, mode: "AM", bw_khz: 25 },
    { id: "weather", label: "NOAA Weather", freq_mhz: 162.55, mode: "FM", bw_khz: 25 },
  ],
};

function mockContext(statusOverride?: unknown): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/sdr/status")) return (statusOverride ?? FIXTURE_STATUS) as unknown;
      if (path.includes("/api/sdr/adsb/aircraft")) return FIXTURE_AIRCRAFT as unknown;
      if (path.includes("/api/sdr/rtl433/events")) return FIXTURE_EVENTS as unknown;
      if (path.includes("/api/sdr/presets")) return FIXTURE_PRESETS as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("SDR screen", () => {
  it("renders status tiles and aircraft table after polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Sdr />
      </WarlockProvider>,
    );

    // Wait for SDR DEVICE tile — only appears in loaded state
    await vi.waitFor(() => expect(lastFrame()).toContain("SDR DEVICE"));

    const frame = lastFrame()!;
    expect(frame).toContain("SDR-SCN");
    expect(frame).toContain("ADS-B");
    expect(frame).toContain("RTL_433");
    expect(frame).toContain("PRESETS");
    expect(frame).toContain("ADS-B AIRCRAFT");
    expect(frame).toContain("UAL123");
    expect(frame).toContain("DAL456");
    unmount();
  });

  it("shows haversine distance for aircraft with position", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Sdr />
      </WarlockProvider>,
    );
    // UAL123 only appears in loaded state with real aircraft data
    await vi.waitFor(() => expect(lastFrame()).toContain("UAL123"));
    const frame = lastFrame()!;
    // Distance column should contain "nm" suffix for aircraft with lat/lon
    expect(frame).toContain("nm");
    unmount();
  });

  it("shows rtl_433 events", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Sdr />
      </WarlockProvider>,
    );
    // LaCrosse only appears when events have loaded
    await vi.waitFor(() => expect(lastFrame()).toContain("LaCrosse"));
    expect(lastFrame()).toContain("RTL_433 EVENTS");
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
        <Sdr />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("acquiring");
    unmount();
  });

  it("shows error tile when status endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("sdr offline"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Sdr />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("sdr offline");
    unmount();
  });

  it("caps aircraft list and shows +N more at narrow terminal height", async () => {
    // 14 aircraft at rows=24 fallback → maxAcft = max(2, 24-14) = 10 → "+4 more"
    const manyAcft = Array.from({ length: 14 }, (_, i) => ({
      icao: `a${String(i).padStart(5, "0")}`,
      callsign: `FLT${String(i).padStart(3, "0")}`,
      altitude_ft: 30000 + i * 1000,
      speed_kt: 400 + i * 5,
      heading: (i * 25) % 360,
      lat: 30.7 + i * 0.1,
      lon: -97.4 - i * 0.1,
      rssi: -20 - i,
      seen_s: 0.5,
      squawk: "1200",
    }));
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/sdr/status")) return FIXTURE_STATUS as unknown;
        if (path.includes("/api/sdr/adsb/aircraft"))
          return { ok: true, count: 14, aircraft: manyAcft } as unknown;
        if (path.includes("/api/sdr/rtl433/events")) return FIXTURE_EVENTS as unknown;
        if (path.includes("/api/sdr/presets")) return FIXTURE_PRESETS as unknown;
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Sdr />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("SDR DEVICE"));
    await vi.waitFor(() => expect(lastFrame()).toMatch(/\+\d+ more/));
    unmount();
  });
});
