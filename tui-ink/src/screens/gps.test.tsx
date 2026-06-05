// GPS screen tests — render + data-layer, following dashboard.test.tsx pattern.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as Gps } from "./gps.js";

const FIXTURE_FIX = {
  ok: true,
  connected: true,
  mode: 3,
  waiting: null,
  lat: 30.71880,
  lon: -97.44360,
  alt: 261.5,
  speed_mps: 0.12,
  track_deg: 270.0,
  climb_mps: 0.01,
  time: "2026-06-05T14:23:17.000Z",
  epx: 1.2,
  epy: 1.5,
  epv: 2.1,
  hdop: 0.9,
  vdop: 1.1,
  pdop: 1.4,
  satellites_seen: 12,
  satellites_used: 8,
};

const FIXTURE_SATS = {
  ok: true,
  connected: true,
  seen: 12,
  used: 8,
  satellites: [
    { prn: 1, constellation: "GPS", elevation: 45, azimuth: 270, snr: 42, used: true },
    { prn: 3, constellation: "GPS", elevation: 23, azimuth: 180, snr: 38, used: true },
    { prn: 7, constellation: "GLONASS", elevation: 12, azimuth: 90, snr: 29, used: false },
  ],
};

const FIXTURE_TIME = {
  ok: true,
  tracking: {
    ok: true,
    stratum: 1,
    last_offset_s: 0.000012,
    rms_offset_s: 0.000008,
    reference_id: "GPS",
  },
  refclocks: [],
  pps: { device: "/dev/pps0", present: true, pulsing: true },
};

const FIXTURE_TRACKS = {
  ok: true,
  tracks: [{ filename: "track1.gpx", name: "Track 1", points: 42, distance_km: 1.2 }],
  recording: { active: false, started: null, filename: null, points: 0 },
};

function mockContext(fixOverride?: unknown): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/gps/fix")) return (fixOverride ?? FIXTURE_FIX) as unknown;
      if (path.includes("/api/gps/sats")) return FIXTURE_SATS as unknown;
      if (path.includes("/api/gps/time")) return FIXTURE_TIME as unknown;
      if (path.includes("/api/gps/tracks")) return FIXTURE_TRACKS as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("GPS screen", () => {
  it("renders position and satellite data after polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Gps />
      </WarlockProvider>,
    );

    // Wait for position tile (only appears in loaded state, not loading/error)
    await vi.waitFor(() => expect(lastFrame()).toContain("POSITION"));

    const frame = lastFrame()!;
    expect(frame).toContain("GPS-NAV");
    expect(frame).toContain("30.71880");
    expect(frame).toContain("ALTITUDE");
    expect(frame).toContain("VELOCITY");
    expect(frame).toContain("GPS TIME");
    expect(frame).toContain("SATELLITES");
    expect(frame).toContain("CHRONY");
    expect(frame).toContain("3D FIX");
    unmount();
  });

  it("shows satellite constellation data", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Gps />
      </WarlockProvider>,
    );
    // Wait for satellites tile (only in loaded state)
    await vi.waitFor(() => expect(lastFrame()).toContain("SATELLITES"));
    const frame = lastFrame()!;
    expect(frame).toContain("GPS"); // constellation name
    unmount();
  });

  it("shows loading state before data resolves", () => {
    // Mock that never resolves
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
        <Gps />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("acquiring");
    unmount();
  });

  it("shows error tile when GPS fix endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gpsd offline"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Gps />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("gpsd offline");
    unmount();
  });

  it("caps satellite list and shows +N more at narrow terminal height", async () => {
    // Build a fixture with 12 satellites — at rows=24 fallback,
    // maxSats = max(2, 24-16) = 8, so hiddenBelow = 4 → "+4 more" expected.
    const manySats = Array.from({ length: 12 }, (_, i) => ({
      prn: i + 1,
      constellation: "GPS",
      elevation: 30 + i,
      azimuth: i * 30,
      snr: 35 + i,
      used: i < 8,
    }));
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/gps/fix")) return FIXTURE_FIX as unknown;
        if (path.includes("/api/gps/sats"))
          return { ok: true, seen: 12, used: 8, satellites: manySats } as unknown;
        if (path.includes("/api/gps/time")) return FIXTURE_TIME as unknown;
        if (path.includes("/api/gps/tracks")) return FIXTURE_TRACKS as unknown;
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Gps />
      </WarlockProvider>,
    );
    // Wait for sats to load (prn 1 appears only in loaded state)
    await vi.waitFor(() => expect(lastFrame()).toContain("POSITION"));
    await vi.waitFor(() => expect(lastFrame()).toMatch(/\+\d+ more/));
    unmount();
  });
});
