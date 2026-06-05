// ESP32 Companion screen tests — lastFrame() assertions + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./esp32_companion.js";

const FIXTURE = {
  module: "esp32_companion",
  label: "ESP32 Companion",
  status: "pending",
  requires_engagement: false,
  todo: [
    "Detect /dev/ttyUSB* or /dev/ttyACM* serial port",
    "Bridge Marauder commands to HTTP API",
    "Unlock BLE spam via serial bridge",
    "Ultra-fast channel hop unlock",
  ],
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async () => FIXTURE as unknown),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("ESP32 Companion screen", () => {
  it("renders pending status and roadmap after fetch", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("COMPANION OFFLINE"));
    const frame = lastFrame()!;
    expect(frame).toContain("PENDING");
    expect(frame).toContain("FEATURE ROADMAP");
    expect(frame).toContain("ESP32 Companion");
    expect(frame).toContain("Detect /dev/ttyUSB");
    expect(frame).toContain("Bridge Marauder");
    unmount();
  });

  it("shows loading tile before data arrives", () => {
    // Make the mock never resolve during this test
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(() => new Promise(() => {})),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    expect(lastFrame()).toContain("ACQUIRING");
    unmount();
  });

  it("shows LINK ERROR when the endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("serial timeout"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("esp32_companion error");
    unmount();
  });
});
