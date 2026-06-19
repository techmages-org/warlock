// Net Diag screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen } from "./netdiag.js";

const STATUS_FIXTURE = {
  ok: true,
  gateway: "192.168.1.1",
  iface: "eth0",
  tools: { ip: true, ethtool: true, iw: true, lldpctl: false, dig: true, mtr: true, ping: true, iperf3: true },
  checks: ["link", "neighbors", "services", "path", "throughput", "health"],
};

const HEALTH_FIXTURE = {
  ok: true,
  iface: "eth0",
  verdict: {
    overall: "PASS",
    checks: [
      { check: "link", verdict: "PASS", detail: "1000Mb/s" },
      { check: "gateway", verdict: "PASS", detail: "0% loss, rtt 1.2ms" },
      { check: "dns", verdict: "PASS", detail: "resolved=true in 18ms" },
      { check: "dhcp", verdict: "PASS", detail: "gw 192.168.1.1 via eth0" },
      { check: "path_mtu", verdict: "PASS", detail: "1500" },
    ],
  },
};

const ERRORS_FIXTURE = { ok: true, iface: "eth0", verdict: "PASS", notes: [] };
const FLAP_FIXTURE = { ok: true, iface: "eth0", verdict: "PASS", note: "stable — no carrier transitions since boot" };
const NTP_FIXTURE = { ok: true, available: true, verdict: "PASS", note: "synced, stratum 2, offset 0.0001s" };
const WAN_FIXTURE = { ok: true, available: true, verdict: "PASS", note: "internet OK, no captive portal" };
const DHCP_SCAN_FIXTURE = { ok: true, iface: "eth0", verdict: "PASS", note: "single DHCP server 192.168.1.1" };
const THROUGHPUT_FIXTURE = {
  ok: true,
  throughput: { available: true, ok: true, server: "192.168.1.1", down_mbps: 412.5, up_mbps: 118.2 },
};

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/netdiag/status")) return STATUS_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path.includes("/api/netdiag/health")) return HEALTH_FIXTURE as unknown;
      if (path.includes("/api/netdiag/errors")) return ERRORS_FIXTURE as unknown;
      if (path.includes("/api/netdiag/flap")) return FLAP_FIXTURE as unknown;
      if (path.includes("/api/netdiag/ntp")) return NTP_FIXTURE as unknown;
      if (path.includes("/api/netdiag/wan")) return WAN_FIXTURE as unknown;
      if (path.includes("/api/netdiag/dhcp_scan")) return DHCP_SCAN_FIXTURE as unknown;
      if (path.includes("/api/netdiag/throughput")) return THROUGHPUT_FIXTURE as unknown;
      throw new Error(`unexpected POST ${path}`);
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("NetDiag screen", () => {
  it("renders the status strip (iface / gateway / tools) after data arrives", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("eth0"));
    const frame = lastFrame()!;
    expect(frame).toContain("IFACE:");
    expect(frame).toContain("192.168.1.1");
    expect(frame).toContain("ethtool✓");
    expect(frame).toContain("lldpctl✗");
    expect(frame).toContain("press r to run diagnostics");
    unmount();
  });

  it("runs the rollup on 'r' and renders the verdict table", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("eth0"));
    stdin.write("r");
    await vi.waitFor(() => expect(lastFrame()).toContain("wan"));
    const frame = lastFrame()!;
    expect(frame).toContain("link");
    expect(frame).toContain("gateway");
    expect(frame).toContain("dns");
    expect(frame).toContain("path_mtu");
    expect(frame).toContain("ethtool");
    expect(frame).toContain("flaps");
    expect(frame).toContain("ntp");
    expect(frame).toContain("PASS");
    expect(frame).toContain("0% loss, rtt 1.2ms");
    const post = ctx.api.post as ReturnType<typeof vi.fn>;
    expect(post.mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/netdiag/health"))).toBe(true);
    expect(post.mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/netdiag/wan"))).toBe(true);
    unmount();
  });

  it("runs the rogue-DHCP scan on 'd'", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("eth0"));
    stdin.write("d");
    await vi.waitFor(() => expect(lastFrame()).toContain("dhcp_scan"));
    expect(lastFrame()).toContain("single DHCP server 192.168.1.1");
    unmount();
  });

  it("opens the iperf prompt on 't' (pre-filled with the gateway) and fires on ↵", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("eth0"));
    stdin.write("t");
    await vi.waitFor(() => expect(lastFrame()).toContain("IPERF3 SERVER"));
    expect(lastFrame()).toContain("engagement-gated");
    stdin.write("\r");
    await vi.waitFor(() =>
      expect(
        (ctx.api.post as ReturnType<typeof vi.fn>).mock.calls.some(
          (c: unknown[]) =>
            String(c[0]).includes("/api/netdiag/throughput") &&
            JSON.stringify(c[1]) === JSON.stringify({ server: "192.168.1.1" }),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("412.5"));
    expect(lastFrame()).toContain("iperf");
    unmount();
  });

  it("surfaces the engagement gate (403) as a flagged FAIL row", async () => {
    const ctx = mockContext();
    (ctx.api.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.includes("/api/netdiag/throughput")) {
        throw new Error("403: engagement OFF — iperf to a non-local server requires an active engagement");
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("eth0"));
    stdin.write("t");
    await vi.waitFor(() => expect(lastFrame()).toContain("IPERF3 SERVER"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("engagement OFF"));
    expect(lastFrame()).toContain("FAIL");
    unmount();
  });

  it("shows LINK ERROR when the status endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("netdiag offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("netdiag error");
    unmount();
  });
});
