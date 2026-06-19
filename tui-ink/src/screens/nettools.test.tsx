// Net Tools screen tests — render + data-layer coverage.
// NOTE: typing into a focused ink-text-input is unreliable under
// ink-testing-library (onChange does not fire on stdin.write), so the
// run-path tests lean on the pre-filled subnet default and the no-input
// speedtest tool — both fire via the screen-owned ↵ handler.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./nettools.js";

const RIGHT = "[C"; // → arrow

const STATUS_FIXTURE = { ok: true, oui_entries: 31842, curl: true, checks: ["subnet", "oui", "wol", "tls", "speedtest"] };

const SUBNET_FIXTURE = {
  ok: true,
  network: "192.168.1.0",
  prefix: 24,
  netmask: "255.255.255.0",
  broadcast: "192.168.1.255",
  total_addresses: 256,
  usable_hosts: 254,
  first_host: "192.168.1.1",
  last_host: "192.168.1.254",
  version: 4,
};

const SPEED_FIXTURE = {
  ok: true,
  download_mbps: 487.21,
  bytes: 25000000,
  seconds: 0.41,
  url: "https://speed.cloudflare.com/__down?bytes=25000000",
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/nettools/status")) return STATUS_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/api/nettools/subnet")) return SUBNET_FIXTURE as unknown;
      if (path.includes("/api/nettools/speedtest")) return SPEED_FIXTURE as unknown;
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("NetTools screen", () => {
  it("renders the tool tabs and status strip after data arrives", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("31842"));
    const frame = lastFrame()!;
    expect(frame).toContain("SUBNET");
    expect(frame).toContain("OUI");
    expect(frame).toContain("WOL");
    expect(frame).toContain("TLS");
    expect(frame).toContain("SPEED");
    expect(frame).toContain("192.168.1.0/24"); // pre-filled default CIDR
    unmount();
  });

  it("runs the subnet calculator on ↵ with the pre-filled CIDR", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("31842"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("255.255.255.0"));
    const frame = lastFrame()!;
    expect(frame).toContain("RESULT — SUBNET");
    expect(frame).toContain("usable_hosts");
    expect(frame).toContain("254");
    expect(
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) =>
          String(c[0]).includes("/api/nettools/subnet") &&
          JSON.stringify(c[1]) === JSON.stringify({ cidr: "192.168.1.0/24" }),
      ),
    ).toBe(true);
    unmount();
  });

  it("switches tools with → and runs the no-input speedtest on ↵", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("31842"));
    stdin.write(RIGHT); // OUI
    stdin.write(RIGHT); // WOL
    stdin.write(RIGHT); // TLS
    stdin.write(RIGHT); // SPEED
    await vi.waitFor(() => expect(lastFrame()).toContain("↵ to run (no input)"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("487.21"));
    expect(lastFrame()).toContain("download_mbps");
    expect(
      (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("/api/nettools/speedtest"),
      ),
    ).toBe(true);
    unmount();
  });

  it("refuses to run an input tool with an empty value (no POST fired)", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("31842"));
    stdin.write(RIGHT); // OUI — empty value
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("enter MAC"));
    expect((ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    unmount();
  });

  it("surfaces a tool failure (e.g. 400 bad CIDR)", async () => {
    const ctx = mockContext();
    (ctx.api.post as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("400: bad CIDR: not enough values"),
    );
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("31842"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("bad CIDR"));
    unmount();
  });

  it("shows LINK ERROR when the status endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("nettools offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("nettools error");
    unmount();
  });
});
