// Ops / Engagements screen tests — render + data-layer coverage.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen, isBlockedTargets } from "./ops.js";

const SAFE_STATUS = {
  ok: true,
  mode: "off",
  engagement_id: null,
  name: "",
  scope: { ssids: [], bssids: [], ip_ranges: [] },
  started_at: null,
  elapsed_s: null,
  auth_statement: "",
};

const ENGAGED_STATUS = {
  ok: true,
  mode: "on",
  engagement_id: "abc-123",
  name: "Red Team Audit Q2",
  scope: { ssids: ["CorpWifi"], bssids: ["aa:bb:cc:00:11:22"], ip_ranges: ["10.0.0.0/24"] },
  started_at: "2026-06-05T10:00:00",
  elapsed_s: 3720,
  auth_statement: "Authorized by Jason Brashear, signed 2026-06-05",
};

const ENG_LIST = {
  ok: true,
  engagements: [
    {
      id: "abc-123",
      name: "Red Team Audit Q2",
      status: "active",
      created_at: "2026-06-05T09:55:00",
      started_at: "2026-06-05T10:00:00",
      ended_at: null,
      targets_count: 3,
    },
  ],
};

const AUDIT_LIST = {
  ok: true,
  audit: [
    {
      id: "evt-001",
      ts: "2026-06-05T10:05:00",
      engagement_id: "abc-123",
      kind: "COMMAND",
      command: "airodump-ng wlan0mon",
      target: "CorpWifi",
      outcome: "ok",
    },
  ],
};

function mockContext(statusFixture = SAFE_STATUS): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/api/ops/status")) return statusFixture as unknown;
      if (path.startsWith("/api/ops/audit")) return AUDIT_LIST as unknown;
      if (path.startsWith("/api/ops/engagements")) return ENG_LIST as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Ops / Engagements screen", () => {
  it("renders SAFE mode when no engagement is active", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(SAFE_STATUS)}>
        <Screen />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("SAFE"));
    const frame = lastFrame()!;
    expect(frame).toContain("SAFE MODE");
    expect(frame).toContain("ENGAGEMENT STATUS");
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    unmount();
  });

  it("renders ENGAGED mode with engagement details", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENGAGED_STATUS)}>
        <Screen />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGED"));
    const frame = lastFrame()!;
    expect(frame).toContain("Red Team Audit Q2");
    expect(frame).toContain("ENGAGED");
    unmount();
  });

  it("shows active engagement details in ACTIVE tab", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(ENGAGED_STATUS)}>
        <Screen />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("abc-123"));
    const frame = lastFrame()!;
    expect(frame).toContain("abc-123");
    expect(frame).toContain("Authorized by Jason");
    unmount();
  });

  it("shows LINK ERROR when the status endpoint fails", async () => {
    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn().mockRejectedValue(new Error("ops offline")),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const { lastFrame, unmount } = render(
      <WarlockProvider value={{ config: { apiUrl: "http://test", auth: null }, api, bus }}>
        <Screen />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("ops error");
    unmount();
  });

});

// ── isBlockedTargets unit tests ───────────────────────────────────────────────
// These test the exported guard function directly — stdin simulation of
// controlled TextInput is unreliable in ink-testing-library, so we test the
// exact function that handleSubmit calls.

describe("isBlockedTargets()", () => {
  it("blocks blank input", () => {
    expect(isBlockedTargets("")).toBe(true);
  });

  it("blocks whitespace-only input", () => {
    expect(isBlockedTargets("   ")).toBe(true);
  });

  it("blocks exact placeholder token set", () => {
    expect(isBlockedTargets("SSID, BSSID, IP/CIDR")).toBe(true);
  });

  it("blocks case-mixed placeholder tokens", () => {
    expect(isBlockedTargets("Ssid, bssid, ip/cidr")).toBe(true);
  });

  it("blocks a bare 'cidr' token", () => {
    expect(isBlockedTargets("cidr")).toBe(true);
  });

  it("passes with a real SSID + CIDR", () => {
    expect(isBlockedTargets("HomeNet, 192.168.0.0/24")).toBe(false);
  });

  it("passes even when some tokens are denylist words, as long as not ALL", () => {
    expect(isBlockedTargets("HomeNet, BSSID")).toBe(false);
  });

  it("passes with a single real SSID", () => {
    expect(isBlockedTargets("CorpWifi")).toBe(false);
  });

  it("passes with a single CIDR", () => {
    expect(isBlockedTargets("10.0.0.0/8")).toBe(false);
  });

  it("passes with a MAC address", () => {
    expect(isBlockedTargets("aa:bb:cc:00:11:22")).toBe(false);
  });
});
