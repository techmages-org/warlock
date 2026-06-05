// Offensive WiFi screen test — mirrors dashboard.test.tsx: mock api client, wrap
// in WarlockProvider, await the polled load, assert the live frame + an error
// frame. Plus: the engagement gate visibly BLOCKS ops when off (no POST), a fire
// against a recon target POSTs the right op when engaged, AND geometry: a long
// target list is bounded to a scrolling window with a "+N more" indicator.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as WifiOffensive } from "./wifi_offensive.js";

const ENTER = "\r";

function makeStatus(engaged: boolean) {
  return {
    ok: true,
    engaged,
    requires_engagement: true,
    iface: { managed: "wlan1", monitor: "mon0" },
    ops: ["deauth", "pmkid", "handshake", "crack", "evil_twin", "karma", "wps"],
    captures: [{ path: "/cap/x.hc22000", filename: "x.hc22000", kind: "hc22000", size_bytes: 2048 }],
    wordlists: [{ filename: "rockyou.txt", path: "/wl/rockyou.txt", size_bytes: 100 }],
    recent_jobs: [
      { id: "j1", type: "wifi.deauth", status: "running", started_at: "2026-06-05T10:00:00", finished_at: null },
    ],
  };
}

function ap(i: number) {
  return { bssid: `AA:BB:CC:DD:${String(i).padStart(2, "0")}:01`, essid: `Net${i}`, channel: 6, encryption: "WPA2", signal: -48, wps: false };
}

function mockContext(engaged: boolean, apCount = 1): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/wifi_offensive/status")) return makeStatus(engaged) as unknown;
      if (path.includes("/api/wifi_recon/aps")) return { aps: Array.from({ length: apCount }, (_, i) => ap(i)) } as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ job_id: "deadbeef0000" })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("WifiOffensive screen", () => {
  it("renders the gate + targets + ops when engaged", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(true)}>
        <WifiOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:00:01"));
    const frame = lastFrame()!;
    expect(frame).toContain("Offensive WiFi");
    expect(frame).toContain("ENGAGED");
    expect(frame).toContain("Net0");
    expect(frame).toContain("Deauth");
    expect(frame).toContain("READY"); // op status
    unmount();
  });

  it("shows the pink ! gate and BLOCKS ops when engagement is off", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(false)}>
        <WifiOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGEMENT REQUIRED"));
    const frame = lastFrame()!;
    expect(frame).toContain("!");
    expect(frame).toContain("BLOCKED");
    unmount();
  });

  it("refuses to fire (no POST) when engagement is off", async () => {
    const ctx = mockContext(false);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:00:01"));
    stdin.write(ENTER); // attempt to fire
    await vi.waitFor(() => expect(lastFrame()).toContain("BLOCKED — engagement OFF"));
    expect(ctx.api.post).not.toHaveBeenCalled();
    unmount();
  });

  it("fires the selected op against the recon target when engaged", async () => {
    const ctx = mockContext(true);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:00:01"));
    stdin.write(ENTER); // fire deauth (default op + first target)
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    expect(ctx.api.post).toHaveBeenCalledWith(
      "/api/wifi_offensive/deauth",
      expect.objectContaining({ bssid: "AA:BB:CC:DD:00:01", count: 64 }),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("Deauth launched"));
    unmount();
  });

  it("bounds a long target list to a scrolling window with +N more", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(true, 30)}>
        <WifiOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("TARGETS — recon APs (30)"));
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
    const ctx = mockContext(true);
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <WifiOffensive />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("wifi_offensive error");
    unmount();
  });
});
