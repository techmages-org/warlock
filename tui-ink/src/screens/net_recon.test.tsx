// Net Recon screen render tests — co-located with the screen per the W2 contract.
// Mock the API client so no real network is needed. Cover:
//   1. loaded state — assert key labels and live data values appear
//   2. error state  — assert LINK ERROR tile shows when status endpoint fails

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as NetRecon } from "./net_recon.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const STATUS_FIXTURE = {
  ok: true,
  subnet: "192.168.1.0/24",
  gateway: "192.168.1.1",
  hosts_seen: 14,
  last_scan: {
    id: "abc123",
    target: "192.168.1.0/24",
    profile: "quick",
    status: "success",
    hosts_found: 12,
  },
  profiles: ["quick", "top1000", "full", "service", "vuln"],
};

const HOSTS_FIXTURE = {
  ok: true,
  count: 3,
  hosts: [
    {
      ip: "192.168.1.1",
      mac: "aa:bb:cc:11:22:33",
      vendor: "Ubiquiti",
      hostname: "router",
      ports: [{ port: 80, proto: "tcp", state: "open", service: "http" }],
      os_guess: "",
      first_seen: "2026-06-05T10:00:00",
      last_seen: "2026-06-05T12:00:00",
    },
    {
      ip: "192.168.1.10",
      mac: "dd:ee:ff:44:55:66",
      vendor: "Apple",
      hostname: "mac-mini",
      ports: [],
      os_guess: "macOS",
      first_seen: "2026-06-05T10:01:00",
      last_seen: "2026-06-05T11:55:00",
    },
    {
      ip: "192.168.1.20",
      mac: "77:88:99:aa:bb:cc",
      vendor: "Dell",
      hostname: "r750",
      ports: [
        { port: 22, proto: "tcp", state: "open", service: "ssh" },
        { port: 443, proto: "tcp", state: "open", service: "https" },
      ],
      os_guess: "Linux",
      first_seen: "2026-06-05T09:00:00",
      last_seen: "2026-06-05T12:01:00",
    },
  ],
};

const ALERTS_FIXTURE = {
  ok: true,
  generated_at: "2026-06-05T12:00:00",
  alerts: [
    {
      type: "new_host" as const,
      severity: "warning" as const,
      ip: "192.168.1.99",
      mac: "11:22:33:44:55:66",
      vendor: "Unknown",
      hostname: "",
      message: "New device 192.168.1.99 appeared on the network",
    },
  ],
  summary: {
    new_host: 1,
    gone_host: 0,
    new_service: 0,
    gone_service: 0,
    mac_changed: 0,
    total: 1,
  },
};

// ─── Mock context factory ──────────────────────────────────────────────────

function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/net_recon/status"))  return STATUS_FIXTURE as unknown;
      if (path.includes("/api/net_recon/hosts"))   return HOSTS_FIXTURE as unknown;
      if (path.includes("/api/net_recon/alerts"))  return ALERTS_FIXTURE as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("NetRecon screen", () => {
  it("renders live network data after the polled load resolves", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <NetRecon />
      </WarlockProvider>,
    );

    // Wait for status to load (primary poll)
    await vi.waitFor(() => expect(lastFrame()).toContain("192.168.1.0/24"));

    const frame = lastFrame()!;
    expect(frame).toContain("07 NET-REC");
    expect(frame).toContain("Net Recon");
    expect(frame).toContain("SUBNET");
    expect(frame).toContain("HOSTS SEEN");
    expect(frame).toContain("GATEWAY");
    expect(frame).toContain("14 hosts");         // hosts_seen
    expect(frame).toContain("192.168.1.1");       // gateway and/or host
    expect(frame).toContain("LAST SCAN");
    expect(frame).toContain("quick");             // last scan profile

    unmount();
  });

  it("renders host rows after hosts endpoint resolves", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <NetRecon />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("192.168.1.10"));

    const frame = lastFrame()!;
    expect(frame).toContain("mac-mini");   // hostname
    expect(frame).toContain("Ubiquiti");   // vendor
    expect(frame).toContain("HOSTS");

    unmount();
  });

  it("caps host list with +N more when hosts exceed the 24-row body budget", async () => {
    // At fallback termRows=24 → bodyBudget=16, ROW_BUDGET=9, maxHostRows=5.
    // With 20 hosts: hasMoreHosts → displayHosts = 4 hosts + "+16 more hosts…"
    const manyHosts = Array.from({ length: 20 }, (_, i) => ({
      ip: `10.0.0.${i + 1}`,
      mac: `aa:bb:cc:dd:${String(i).padStart(2, "0")}:00`,
      vendor: "VendorCo",
      hostname: `host-${i + 1}`,
      ports: [] as { port: number; proto: string; state: string; service: string }[],
      os_guess: "",
      first_seen: null as string | null,
      last_seen: null as string | null,
    }));

    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/net_recon/status"))  return STATUS_FIXTURE as unknown;
        if (path.includes("/api/net_recon/hosts"))   return { ok: true, count: 20, hosts: manyHosts } as unknown;
        if (path.includes("/api/net_recon/alerts"))  return ALERTS_FIXTURE as unknown;
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };

    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <NetRecon />
      </WarlockProvider>,
    );

    // Wait for the +N more indicator to appear (list capped)
    await vi.waitFor(() => expect(lastFrame()).toMatch(/\+\d+\s*more/));

    const frame = lastFrame()!;
    expect(frame).toContain("10.0.0.1");       // first host visible
    expect(frame).not.toContain("10.0.0.20");  // last host hidden by cap
    expect(frame).toMatch(/\+\d+\s*more/);    // truncation indicator present

    unmount();
  });

  it("shows LINK ERROR tile when the status endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("refused"));

    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <NetRecon />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("net_recon error");

    unmount();
  });
});
