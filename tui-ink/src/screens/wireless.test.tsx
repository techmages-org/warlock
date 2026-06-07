// Wireless flagship FSM test — mirrors dashboard.test.tsx: mock api client, wrap
// in WarlockProvider, await the polled load, assert the live frame + an error
// frame. Plus FSM coverage: ARM posts start, RECON→lock target, ACT fires a
// gated op against the locked target, and the engagement gate is shown.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import type { EngagementStatus } from "../lib/types.js";
import { Screen as Wireless } from "./wireless.js";

const ENTER = "\r";
const DOWN = String.fromCharCode(27) + "[B"; // ESC [ B = down arrow

const STATUS = { ok: true, running: true, iface: "mon0", aps_seen: 2, clients_seen: 1, uptime_s: 30 };
const APS = {
  aps: [
    { bssid: "AA:BB:CC:DD:EE:01", essid: "HomeNet", channel: 6, encryption: "WPA2", signal: -50, wps: false },
    { bssid: "AA:BB:CC:DD:EE:02", essid: "GuestNet", channel: 11, encryption: "WPA2", signal: -65, wps: true },
  ],
};

function engStatus(on: boolean): EngagementStatus {
  return {
    mode: on ? "on" : "off",
    engagement_id: on ? "eng-1" : null,
    name: on ? "RedOp" : "",
    scope: { ssids: [], bssids: [], ip_ranges: [] },
    started_at: on ? "2026-06-05T10:00:00" : null,
  };
}

function mockContext(engaged: boolean): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/wifi_recon/status")) return STATUS as unknown;
      if (path.includes("/api/wifi_recon/aps")) return APS as unknown;
      if (path.includes("/api/wifi_recon/clients")) return { clients: [] } as unknown;
      if (path.includes("/api/wifi_recon/handshakes")) return { handshakes: [] } as unknown;
      if (path.includes("/api/engagements/active")) return engStatus(engaged) as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ job_id: "cafef00d0000" })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Wireless flagship screen", () => {
  it("renders the stepper + ARM step after the polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(true)}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ARM THE RADIO"));
    const frame = lastFrame()!;
    expect(frame).toContain("Guided Flow");
    expect(frame).toContain("ARM");
    expect(frame).toContain("RECON");
    expect(frame).toContain("LOOT");
    expect(frame).toContain("ARMED"); // radio running
    unmount();
  });

  it("walks ARM → RECON → TARGET → ACT and fires a gated op", async () => {
    const ctx = mockContext(true);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ARM THE RADIO"));

    stdin.write("2"); // → RECON
    await vi.waitFor(() => expect(lastFrame()).toContain("ACCESS POINTS"));
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:EE:01"));

    stdin.write(DOWN); // move selection to 2nd AP
    // Wait for the cursor to land on row 2 (also forces the render commit so the
    // handler's apIdx ref is current before we lock).
    await vi.waitFor(() => expect(lastFrame()).toMatch(/›\s+AA:BB:CC:DD:EE:02/));
    stdin.write(ENTER); // lock target → TARGET step
    await vi.waitFor(() => expect(lastFrame()).toContain("GuestNet"));
    await vi.waitFor(() => expect(lastFrame()).toContain("ACT on this target"));

    stdin.write(ENTER); // → ACT step
    await vi.waitFor(() => expect(lastFrame()).toContain("ACT — GuestNet"));
    stdin.write(ENTER); // fire deauth (default selected)
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    expect(ctx.api.post).toHaveBeenCalledWith(
      "/api/wifi_offensive/deauth",
      expect.objectContaining({ bssid: "AA:BB:CC:DD:EE:02", count: 64 }),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("Deauth launched"));
    unmount();
  });

  it("shows the pink ! gate in ACT and refuses to fire when engagement is off", async () => {
    const ctx = mockContext(false);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ARM THE RADIO"));
    stdin.write("2"); // RECON
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:EE:01"));
    stdin.write(ENTER); // lock first AP
    await vi.waitFor(() => expect(lastFrame()).toContain("ACT on this target"));
    stdin.write("4"); // ACT
    await vi.waitFor(() => expect(lastFrame()).toContain("REQUIRES AN ACTIVE ENGAGEMENT"));
    expect(lastFrame()).toContain("BLOCKED");
    stdin.write(ENTER); // attempt fire
    await vi.waitFor(() => expect(lastFrame()).toContain("blocked — no active engagement"));
    expect(ctx.api.post).not.toHaveBeenCalled();
    unmount();
  });

  it("adds the selected RECON AP to engagement scope on 's'", async () => {
    const ctx = mockContext(true);
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ARM THE RADIO"));
    stdin.write("2"); // → RECON
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:EE:01"));
    stdin.write("s"); // add the selected (first) AP to scope
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    expect(ctx.api.post).toHaveBeenCalledWith(
      "/api/ops/engagements/scope/add",
      expect.objectContaining({ targets: ["HomeNet", "AA:BB:CC:DD:EE:01"] }),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("added HomeNet to scope ✓"));
    unmount();
  });

  it("shows the gate hint when add-to-scope returns 409 (no active engagement)", async () => {
    const ctx = mockContext(false);
    (ctx.api.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.includes("/api/ops/engagements/scope/add")) {
        throw new Error("409 Conflict — /api/ops/engagements/scope/add");
      }
      return {};
    });
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ARM THE RADIO"));
    stdin.write("2"); // → RECON
    await vi.waitFor(() => expect(lastFrame()).toContain("AA:BB:CC:DD:EE:01"));
    stdin.write("s"); // attempt add-to-scope → 409
    await vi.waitFor(() => expect(lastFrame()).toContain("no active engagement — start one on Operations (g e)"));
    unmount();
  });

  it("windowOf keeps selected AP visible when scrolling past the 6-row cap", async () => {
    // Build 8 APs — selection past row 6 exposed the slice(0,6) bug where
    // the '›' indicator was never rendered (hidden selection).
    const manyAps = Array.from({ length: 8 }, (_, i) => ({
      bssid: `AA:BB:CC:DD:EE:${String(i + 1).padStart(2, "0")}`,
      essid: `Net-${i + 1}`,
      channel: (i % 11) + 1,
      encryption: "WPA2",
      signal: -(50 + i),
      wps: false,
    }));
    const ctx = mockContext(true);
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.includes("/api/wifi_recon/status")) return STATUS as unknown;
      if (path.includes("/api/wifi_recon/aps")) return { aps: manyAps } as unknown;
      if (path.includes("/api/wifi_recon/clients")) return { clients: [] } as unknown;
      if (path.includes("/api/wifi_recon/handshakes")) return { handshakes: [] } as unknown;
      if (path.includes("/api/engagements/active")) return { mode: "on", engagement_id: "e1", name: "Test", scope: { ssids: [], bssids: [], ip_ranges: [] }, started_at: null } as unknown;
      throw new Error(`unexpected GET ${path}`);
    });
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ARM THE RADIO"));
    stdin.write("2"); // → RECON
    await vi.waitFor(() => expect(lastFrame()).toContain("Net-1"));

    // Navigate down 7 times to select the 8th AP
    for (let i = 0; i < 7; i++) {
      stdin.write(DOWN);
      await vi.waitFor(() => {}, { timeout: 100 });
    }
    // The 8th AP should be visible with the '›' cursor
    await vi.waitFor(() => {
      const frame = lastFrame()!;
      return frame.includes("Net-8") && /›\s+AA:BB:CC:DD:EE:08/.test(frame);
    }, { timeout: 2000 });
    const frame = lastFrame()!;
    expect(frame).toContain("Net-8");
    expect(frame).toMatch(/›\s+AA:BB:CC:DD:EE:08/);
    // Also confirm the '+N more' indicator appears when scrolled
    expect(frame).toContain("+");
    unmount();
  });

  it("shows an error tile when the recon status endpoint fails", async () => {
    const ctx = mockContext(true);
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Wireless />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("wireless error");
    unmount();
  });
});
