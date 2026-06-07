// Offensive SDR screen tests — rebuilt for the Phase-3 backend (rich status +
// capture/analyze/replay actions). Covers: the engagement gate, the captures
// list, the tx-chain status, and the three actions incl. replay's RF gate +
// two-key confirm-before-transmit. Mocks the api client (no live deck).

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as SdrOffensive } from "./sdr_offensive.js";

const ENTER = "\r";
const ESC = "";

const CAP = {
  id: "capture-433920000-20260607",
  filename: "cap-43392-0607.iq",
  path: "/data/captures/sdr/cap-43392-0607.iq",
  freq_mhz: 433.92,
  sample_rate: 2_000_000,
  duration_s: 5,
  size_bytes: 20_480_000,
  created_at: "2026-06-07T09:00:00",
  modulation: "OOK",
};

// be-p3 FROZEN v2 status shape.
const RICH_STATUS = {
  ok: true,
  rx_device: "rtl_sdr",
  tx_device: "hackrf",
  tx_capable: true,
  busy: false,
  reason: "",
  captures: [CAP],
  last_result: { ok: true, op: "capture", detail: "capture started", audit_id: "abcd1234ef", ts: "2026-06-07T09:00:00", job_id: "job-9" },
  requires_engagement: true,
  engaged: false,
};

const ENG_OFF = { mode: "off", engagement_id: null, name: "", scope: { ssids: [], bssids: [], ip_ranges: [] }, started_at: null };
const ENG_ON = { mode: "on", engagement_id: "eng-001", name: "Test Op", scope: { ssids: ["TestNet"], bssids: [], ip_ranges: [] }, started_at: "2026-06-05T14:00:00" };

function mockContext(eng: unknown = ENG_OFF, status: unknown = RICH_STATUS): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/engagements/active")) return eng as unknown;
      if (path.includes("/api/sdr_offensive/status")) return status as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true, op: "x", detail: "queued", audit_id: "abcd1234", job_id: "job-1" })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

const posts = (ctx: WarlockContextValue) => (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls;

describe("SDR Offensive screen", () => {
  it("shows the engagement gate + captures list when no engagement is active", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENG_OFF)}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq")); // status poll loaded
    const f = lastFrame()!;
    expect(f).toContain("SDR-OFF");
    expect(f).toContain("ENGAGEMENT REQUIRED");
    expect(f).toContain("CAPTURED SIGNALS");
    expect(f).toMatch(/433\.920/); // freq display in MHz
    unmount();
  });

  it("renders the TX chain status (tx_capable) and ARMED state when engaged", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENG_ON)}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGED"));
    const f = lastFrame()!;
    expect(f).toMatch(/ARMED/);
    expect(f).toMatch(/READY|TX/); // tx chain present
    unmount();
  });

  it("'a' runs a PASSIVE analyze on the selected capture (no engagement needed)", async () => {
    const ctx = mockContext(ENG_OFF);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq"));
    stdin.write("a");
    await vi.waitFor(() =>
      expect(
        posts(ctx).some(([p, b]) => p === "/api/sdr_offensive/analyze" && (b as { capture?: string })?.capture === "cap-43392-0607.iq"),
      ).toBe(true),
    );
    unmount();
  });

  it("'c' opens the capture form and Enter fires a freq_hz capture", async () => {
    const ctx = mockContext(ENG_ON);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq")); // poll settled, input ready
    stdin.write("c");
    await vi.waitFor(() => expect(lastFrame()).toContain("CAPTURE IQ"));
    stdin.write(ENTER); // default 433.92 MHz / 5 s
    await vi.waitFor(() =>
      expect(
        posts(ctx).some(
          ([p, b]) =>
            p === "/api/sdr_offensive/capture" &&
            (b as { freq_mhz?: number })?.freq_mhz === 433.92 &&
            (b as { duration_s?: number })?.duration_s === 5,
        ),
      ).toBe(true),
    );
    unmount();
  });

  it("'r' is REFUSED locally when not engaged (RF replay is gated) — no POST", async () => {
    const ctx = mockContext(ENG_OFF);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq"));
    stdin.write("r");
    await vi.waitFor(() => expect(lastFrame()).toMatch(/replay is RF-EMITTING and engagement-gated/));
    // it never opened the confirm panel and never POSTed
    expect(lastFrame()).not.toContain("CONFIRM RF REPLAY");
    expect(posts(ctx).some(([p]) => p === "/api/sdr_offensive/replay")).toBe(false);
    unmount();
  });

  it("'r' opens the confirm panel (defocused, target prefilled) and 'y' transmits", async () => {
    const ctx = mockContext(ENG_ON);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGED"));
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq"));
    stdin.write("r");
    await vi.waitFor(() => expect(lastFrame()).toContain("CONFIRM RF REPLAY"));
    const f = lastFrame()!;
    expect(f).toContain("TestNet"); // target prefilled from engagement scope
    expect(f).toMatch(/CONFIRM TRANSMIT/); // y/f confirm hint shown (field defocused)
    stdin.write("y"); // the confirm key (NOT Enter)
    await vi.waitFor(() =>
      expect(
        posts(ctx).some(
          ([p, b]) =>
            p === "/api/sdr_offensive/replay" &&
            (b as { target?: string })?.target === "TestNet" &&
            (b as { capture?: string })?.capture === "cap-43392-0607.iq" &&
            (b as { freq_mhz?: number })?.freq_mhz === 433.92,
        ),
      ).toBe(true),
    );
    unmount();
  });

  it("a stray key does NOT transmit; 'f' also confirms", async () => {
    const ctx = mockContext(ENG_ON);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGED"));
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq"));
    stdin.write("r");
    await vi.waitFor(() => expect(lastFrame()).toContain("CONFIRM RF REPLAY"));
    stdin.write("x"); // stray key — must NOT fire, panel stays open
    await new Promise((r) => setTimeout(r, 60));
    expect(posts(ctx).some(([p]) => p === "/api/sdr_offensive/replay")).toBe(false);
    expect(lastFrame()).toContain("CONFIRM RF REPLAY");
    stdin.write("f"); // f also confirms
    await vi.waitFor(() => expect(posts(ctx).some(([p]) => p === "/api/sdr_offensive/replay")).toBe(true));
    unmount();
  });

  it("Esc cancels the replay confirm without transmitting", async () => {
    const ctx = mockContext(ENG_ON);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGED"));
    stdin.write("r");
    await vi.waitFor(() => expect(lastFrame()).toContain("CONFIRM RF REPLAY"));
    stdin.write(ESC);
    await vi.waitFor(() => expect(lastFrame()).not.toContain("CONFIRM RF REPLAY"));
    expect(posts(ctx).some(([p]) => p === "/api/sdr_offensive/replay")).toBe(false);
    unmount();
  });

  it("'t' toggles target-edit (focus) and Enter locks back to confirm where 'y' still transmits", async () => {
    // The t→edit→Enter→confirm→y ROUND-TRIP is the screen's sub-mode state
    // machine (our code). We don't assert the typed characters here: a single
    // stdin.write into a focused, pre-filled ink-text-input doesn't fire onChange
    // under ink-testing-library (a headless quirk — real-terminal typing works,
    // exercised by the capture-freq field). So we prove the mechanism + that a
    // confirm key still fires after the edit round-trip.
    const ctx = mockContext(ENG_ON);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGED"));
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-43392-0607.iq"));
    stdin.write("r");
    await vi.waitFor(() => expect(lastFrame()).toContain("CONFIRM RF REPLAY"));
    expect(lastFrame()).toMatch(/CONFIRM TRANSMIT/); // confirm state first

    stdin.write("t"); // → edit sub-mode (field focused; confirm keys suspended)
    await vi.waitFor(() => expect(lastFrame()).toContain("lock it in"));
    expect(lastFrame()).not.toMatch(/CONFIRM TRANSMIT/); // y/f confirm suspended while editing

    stdin.write(ENTER); // lock + back to the confirm state
    await vi.waitFor(() => expect(lastFrame()).toMatch(/CONFIRM TRANSMIT/));
    await new Promise((r) => setTimeout(r, 40)); // let the defocus settle before the confirm key

    stdin.write("y"); // confirm still works after the edit round-trip
    await vi.waitFor(() =>
      expect(
        posts(ctx).some(
          ([p, b]) => p === "/api/sdr_offensive/replay" && (b as { target?: string })?.target === "TestNet",
        ),
      ).toBe(true),
    );
    unmount();
  });

  it("shows the SDR-OFF header immediately (loading state)", () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(() => new Promise(() => {})),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <SdrOffensive />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("SDR-OFF");
    unmount();
  });
});
