// System screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./system.js";

const STATUS_FIXTURE = {
  ok: true,
  hostname: "warlock",
  uptime_s: 90061, // 1d 1h 1m
  cpu_percent: 22.5,
  load_avg: [0.8, 0.6, 0.4],
  temp_c: 54.2,
  memory: { total_mb: 8064, available_mb: 6200, percent: 23.1 },
  disk_root: { free_mb: 45000, total_mb: 64000, percent: 29.7 },
};

const AIO_FIXTURE = {
  ok: true,
  rails: {
    gps: { gpio: 16, available: true, level: 1, label: "GPS Power Rail" },
    lora: { gpio: 23, available: true, level: 0, label: "LoRa Power Rail" },
    internal_usb: { gpio: 27, available: true, level: 1, label: "Internal USB Hub" },
    spare6: { gpio: 6, available: false, level: 0, label: "Spare GPIO-6" },
    spare7: { gpio: 7, available: false, level: 0, label: "Spare GPIO-7" },
  },
};

const SVC_FIXTURE = {
  ok: true,
  services: [
    { unit: "warlock.service", activestate: "active", substate: "running", enabled: "enabled" },
    { unit: "meshtasticd.service", activestate: "inactive", substate: "dead", enabled: "disabled" },
    { unit: "gpsd.service", activestate: "active", substate: "running", enabled: "enabled" },
  ],
};

const NET_FIXTURE = {
  ok: true,
  interfaces: [
    { name: "eth0", type: "802-3-ethernet", up: true, ipv4: "192.168.1.50", ipv6: null, mac: "aa:bb:cc:dd:ee:ff", speed: 1000, mtu: 1500 },
    { name: "wlan0", type: "802-11-wireless", up: false, ipv4: null, ipv6: null, mac: "11:22:33:44:55:66", speed: null, mtu: 1500 },
  ],
};

const LOG_FIXTURE = {
  ok: true,
  lines: ["Jun 05 10:00:01 warlock warlock[1]: listening on :7777", "Jun 05 10:00:02 warlock kismet: started"],
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/system/status")) return STATUS_FIXTURE as unknown;
      if (path.includes("/api/system/aio")) return AIO_FIXTURE as unknown;
      if (path.includes("/api/system/services")) return SVC_FIXTURE as unknown;
      if (path.includes("/api/system/network")) return NET_FIXTURE as unknown;
      if (path.includes("/api/system/journal")) return LOG_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("System screen", () => {
  it("renders status strip and HW tab after data arrives", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("warlock"));
    const frame = lastFrame()!;
    expect(frame).toContain("CPU:");
    expect(frame).toContain("TEMP:");
    expect(frame).toContain("54"); // temp_c rounded
    expect(frame).toContain("[1] HARDWARE");
    expect(frame).toContain("AIO / GPIO RAILS");
    unmount();
  });

  it("shows AIO rail data in HW tab", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("gps"));
    const frame = lastFrame()!;
    expect(frame).toContain("lora");
    expect(frame).toContain("ON");
    unmount();
  });

  it("shows LINK ERROR when the status endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("system offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("system error");
    unmount();
  });
});
