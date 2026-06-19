// VoIP screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./voip.js";

const STATUS_FIXTURE = { ok: true, tshark: true, checks: ["analyze"] };

const CAP_LIST_FIXTURE = {
  ok: true,
  count: 2,
  captures: [
    { id: "cap-1749500000-a1b2c3", bytes: 145632, mtime: 1749500000 },
    { id: "cap-1749400000-d4e5f6", bytes: 9821, mtime: 1749400000 },
  ],
};

const ANALYZE_FIXTURE = {
  ok: true,
  id: "cap-1749500000-a1b2c3",
  rtp_streams: [
    {
      src: "10.0.0.5:16384",
      dst: "10.0.0.9:16386",
      ssrc: "0xDEADBEEF",
      codec: "g711U",
      packets: 2450,
      lost: 12,
      loss_pct: 0.5,
      mean_jitter_ms: 4.2,
      max_jitter_ms: 11.8,
      mos: 4.21,
      r_factor: 88.4,
      quality: "good",
    },
  ],
  stream_count: 1,
  worst_mos: 4.21,
  overall: "good",
  qos: {
    rtp_dscp: 46,
    rtp_dscp_name: "EF (voice)",
    marked_ef: true,
    verdict: "PASS",
    note: "voice marked EF(46)",
  },
  sip_messages: 14,
  sip_raw: null,
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/voip/status")) return STATUS_FIXTURE as unknown;
      if (path.includes("/api/capture/list")) return CAP_LIST_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/api/voip/analyze")) return ANALYZE_FIXTURE as unknown;
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("VoIP screen", () => {
  it("renders tshark availability and the capture picker", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    const frame = lastFrame()!;
    expect(frame).toContain("tshark✓");
    expect(frame).toContain("CAPTURES (2)");
    expect(frame).toContain("RTP QUALITY");
    expect(frame).toContain("press a");
    unmount();
  });

  it("analyzes the selected capture on 'a' — MOS / codec / QoS / SIP", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    stdin.write("a");
    await vi.waitFor(() => expect(lastFrame()).toContain("4.21"));
    const frame = lastFrame()!;
    expect(frame).toContain("g711U");
    expect(frame).toContain("good");
    expect(frame).toContain("voice marked EF(46)");
    expect(frame).toContain("SIP messages:");
    expect(frame).toContain("14");
    expect(
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) =>
          String(c[0]).includes("/api/voip/analyze") &&
          JSON.stringify(c[1]) === JSON.stringify({ id: "cap-1749500000-a1b2c3" }),
      ),
    ).toBe(true);
    unmount();
  });

  it("shows the no-RTP result without crashing", async () => {
    const ctx = mockContext();
    (ctx.api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ANALYZE_FIXTURE,
      rtp_streams: [],
      stream_count: 0,
      worst_mos: null,
      overall: "no-rtp",
      qos: { rtp_dscp: null, rtp_dscp_name: null, marked_ef: false, verdict: "INFO", note: "no RTP DSCP samples" },
    });
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    stdin.write("a");
    await vi.waitFor(() => expect(lastFrame()).toContain("no RTP streams found"));
    expect(lastFrame()).toContain("no-rtp");
    unmount();
  });

  it("surfaces an analyze failure (e.g. 404 capture not found)", async () => {
    const ctx = mockContext();
    (ctx.api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("404: capture not found"));
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    stdin.write("a");
    await vi.waitFor(() => expect(lastFrame()).toContain("analyze failed"));
    expect(lastFrame()).toContain("404: capture not found");
    unmount();
  });

  it("shows LINK ERROR when the status endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("voip offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("voip error");
    unmount();
  });
});
