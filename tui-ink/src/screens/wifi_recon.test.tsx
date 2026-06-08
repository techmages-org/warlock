// WiFi Recon screen test — mirrors dashboard.test.tsx: mock the api client, wrap
// in WarlockProvider, await the polled load, assert the live frame + an error
// frame, a Control-view scan start, AND geometry: a long AP list is bounded to a
// scrolling window with a "+N more" indicator (default ITL terminal = 24x120).

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as WifiRecon } from "./wifi_recon.js";

const STATUS = { ok: true, running: false, iface: "mon0", channels: "all", aps_seen: 2, clients_seen: 1, uptime_s: 42 };

function ap(i: number) {
  return {
    bssid: `AA:BB:CC:DD:${String(i).padStart(2, "0")}:01`,
    essid: `Net${i}`,
    channel: 6,
    encryption: "WPA2",
    signal: -52,
    beacons: 100,
    wps: false,
  };
}

function mockContext(apCount = 2): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/wifi_recon/status")) return STATUS as unknown;
      if (path.includes("/api/wifi_recon/aps")) return { aps: Array.from({ length: apCount }, (_, i) => ap(i)) } as unknown;
      if (path.includes("/api/wifi_recon/clients")) return { clients: [] } as unknown;
      if (path.includes("/api/wifi_recon/handshakes")) return { handshakes: [] } as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("WifiRecon screen", () => {
  it("renders recon status + APs after the polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <WifiRecon />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ACCESS POINTS"));
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:00:01"));
    const frame = lastFrame()!;
    expect(frame).toContain("WiFi Recon");
    expect(frame).toContain("mon0");
    expect(frame).toContain("Net0");
    unmount();
  });

  it("starts a scan from the Control view", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiRecon />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ACCESS POINTS"));
    stdin.write("4"); // → Control view
    await vi.waitFor(() => expect(lastFrame()).toContain("CAPTURE CONTROL"));
    stdin.write("s"); // start
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    expect(ctx.api.post).toHaveBeenCalledWith("/api/wifi_recon/start", { channels: "all" });
    await vi.waitFor(() => expect(lastFrame()).toContain("scan started"));
    unmount();
  });

  it("bounds a long AP list to a scrolling window with +N more", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(30)}>
        <WifiRecon />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ACCESS POINTS (30 ")); // "(30 · N geo)"
    const frame = lastFrame()!;
    expect(frame).toMatch(/\+\d+ more/);
    expect(frame).toContain("/30)");
    const shown = (frame.match(/AA:BB:CC:DD:/g) ?? []).length;
    expect(shown).toBeLessThan(30);
    // Verified bounded: total body height fits the 24-row budget (rows - chrome 8).
    const lines = frame.split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    expect(lines.length).toBeLessThanOrEqual(16);
    unmount();
  });

  it("shows an error tile when the endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiRecon />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("wifi_recon error");
    unmount();
  });
});
