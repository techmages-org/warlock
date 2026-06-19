// Capture screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./capture.js";

const STATUS_FIXTURE = { ok: true, tshark: true, dumpcap: true, captures: 2 };

const LIST_FIXTURE = {
  ok: true,
  count: 2,
  captures: [
    { id: "cap-1749500000-a1b2c3", bytes: 145632, mtime: 1749500000 },
    { id: "cap-1749400000-d4e5f6", bytes: 9821, mtime: 1749400000 },
  ],
};

const START_FIXTURE = {
  ok: true,
  id: "cap-1749510000-aabbcc",
  iface: "eth0",
  filter: null,
  seconds: 10,
  packets: 1423,
  bytes: 256000,
};

const ANALYZE_FIXTURE = {
  ok: true,
  id: "cap-1749500000-a1b2c3",
  expert: [
    { finding: "TCP retransmission (suspected)", count: 41 },
    { finding: "Duplicate ACK", count: 12 },
  ],
  top_talkers: [
    { a: "192.168.1.50", b: "192.168.1.10", frames: 900, bytes: 120000 },
  ],
  protocol_hierarchy: "eth\n  ip\n    tcp",
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/capture/status")) return STATUS_FIXTURE as unknown;
      if (path.includes("/api/capture/list")) return LIST_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/api/capture/start")) return START_FIXTURE as unknown;
      if (path.includes("/api/capture/analyze")) return ANALYZE_FIXTURE as unknown;
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Capture screen", () => {
  it("renders the capture list with sizes and the download path", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    const frame = lastFrame()!;
    expect(frame).toContain("CAPTURES (2)");
    expect(frame).toContain("cap-1749400000-d4e5f6");
    expect(frame).toContain("tshark✓");
    expect(frame).toContain("/api/capture/download/cap-1749500000-a1b2c3");
    unmount();
  });

  it("starts a bounded capture on 's' and reports the result", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    stdin.write("s");
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749510000-aabbcc"));
    expect(lastFrame()).toContain("1423 pkts");
    const post = ctx.api.post as ReturnType<typeof vi.fn>;
    expect(
      post.mock.calls.some(
        (c: unknown[]) =>
          String(c[0]).includes("/api/capture/start") &&
          JSON.stringify(c[1]) === JSON.stringify({ seconds: 10 }),
      ),
    ).toBe(true);
    unmount();
  });

  it("analyzes the selected capture on 'a' (expert findings + top talkers)", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749500000-a1b2c3"));
    stdin.write("a");
    await vi.waitFor(() => expect(lastFrame()).toContain("TCP retransmission"));
    const frame = lastFrame()!;
    expect(frame).toContain("EXPERT FINDINGS");
    expect(frame).toContain("41×");
    expect(frame).toContain("TOP TALKERS");
    expect(frame).toContain("192.168.1.50");
    expect(
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) =>
          String(c[0]).includes("/api/capture/analyze") &&
          JSON.stringify(c[1]) === JSON.stringify({ id: "cap-1749500000-a1b2c3" }),
      ),
    ).toBe(true);
    unmount();
  });

  it("analyzes the SECOND capture after pressing j", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("cap-1749400000-d4e5f6"));
    stdin.write("j");
    stdin.write("a");
    await vi.waitFor(() =>
      expect(
        (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
          (c: unknown[]) =>
            String(c[0]).includes("/api/capture/analyze") &&
            JSON.stringify(c[1]) === JSON.stringify({ id: "cap-1749400000-d4e5f6" }),
        ),
      ).toBe(true),
    );
    unmount();
  });

  it("shows LINK ERROR when the status endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("capture offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("capture error");
    unmount();
  });
});
