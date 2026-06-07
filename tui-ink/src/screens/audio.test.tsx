// Audio screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./audio.js";

const FIXTURE = {
  ok: true,
  sinks: [
    { id: 47, name: "alsa_output.pci-0000_00_1f.3.analog-stereo", default: true, volume: 0.8, muted: false },
    { id: 52, name: "bluez_sink.AA_BB_CC_DD_EE_FF.a2dp_sink", default: false, volume: 0.0, muted: true },
  ],
  sources: [
    { id: 48, name: "alsa_input.pci-0000_00_1f.3.analog-stereo", default: true, volume: 1.0, muted: false },
  ],
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async () => FIXTURE as unknown),
    post: vi.fn(async () => ({ ok: true })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Audio screen", () => {
  it("renders sink list with default + volume after fetch", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );

    // Wait for device list to render (device name only appears after data loads)
    await vi.waitFor(() => expect(lastFrame()).toContain("alsa_output.pci"));
    const frame = lastFrame()!;
    expect(frame).toContain("OUTPUT SINKS");
    expect(frame).toContain("DEF");
    expect(frame).toContain("80%");  // first sink volume 0.8 → 80%
    expect(frame).toContain("2 sinks");
    expect(frame).toContain("1 sources");
    expect(frame).toContain("j/k:move");
    unmount();
  });

  it("switches to INPUT SOURCES view on key '2'", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("alsa_output.pci"));
    stdin.write("2"); // → sources view
    await vi.waitFor(() => expect(lastFrame()).toContain("INPUT SOURCES"));
    expect(lastFrame()).toContain("alsa_input.pci");
    unmount();
  });

  it("calls set-default API when 'd' is pressed", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("alsa_output.pci"));
    stdin.write("d"); // set default on selected (id=47)
    await vi.waitFor(() =>
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => String(c[0]).includes("/api/audio/default")
      )
    );
    expect(ctx.api.post).toHaveBeenCalledWith("/api/audio/default", expect.objectContaining({ id: 47 }));
    unmount();
  });

  it("calls mute API when 'm' is pressed", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("alsa_output.pci"));
    stdin.write("m"); // mute the selected sink (id=47, currently unmuted)
    await vi.waitFor(() =>
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => String(c[0]).includes("/api/audio/mute")
      )
    );
    expect(ctx.api.post).toHaveBeenCalledWith("/api/audio/mute", expect.objectContaining({ id: 47, muted: true }));
    unmount();
  });

  it("shows acquiring state before data arrives", () => {
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
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("wpctl offline"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("audio error");
    unmount();
  });
});
