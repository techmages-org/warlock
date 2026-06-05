// Server Audit screen render tests — co-located with the screen per the W2 contract.
// Mock the API client so no real network is needed. Cover:
//   1. loaded + engaged state — assert key labels, jobs, engagement gate indicator
//   2. loaded + not engaged   — assert pink ! engagement-off banner appears
//   3. error state            — assert LINK ERROR tile shows

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as ServerAudit } from "./server_audit.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const AUDIT_TYPES = [
  { id: "nmap-vuln",  label: "nmap vuln scan",          remote: true,  tool: "nmap",  tool_present: true },
  { id: "nikto",      label: "nikto web scan",           remote: true,  tool: "nikto", tool_present: false },
  { id: "lynis",      label: "lynis host hardening",     remote: false, tool: "lynis", tool_present: true },
  { id: "ssh-config", label: "ssh remote config audit",  remote: true,  tool: "ssh",   tool_present: true },
];

const makeStatus = (engaged: boolean) => ({
  ok: true,
  module: "server_audit",
  label: "Server Audit",
  requires_engagement: true,
  engaged,
  engagement: { mode: engaged ? "on" : "off", engagement_id: null, name: "", scope: { ssids: [], bssids: [], ip_ranges: [] }, started_at: null },
  audit_types: AUDIT_TYPES,
  severities: ["critical", "high", "medium", "low", "info"],
  counts: { queued: 0, running: 0, success: 2, failed: 0, cancelled: 0, error: 0, unavailable: 0, total: 2 },
  jobs: [
    {
      id: "job-001",
      audit_type: "lynis",
      type: "lynis",
      target: "localhost",
      note: "lynis host hardening",
      remote: false,
      status: "success",
      findings: [
        { severity: "high",   title: "Warning [BOOT-5264]", detail: "GRUB bootloader not password protected", target: "localhost" },
        { severity: "medium", title: "Suggestion [AUTH-9286]", detail: "Configure minimum password age", target: "localhost" },
        { severity: "info",   title: "Hardening index: 62/100", detail: "lynis hardening index = 62", target: "localhost" },
      ],
      summary: { critical: 0, high: 1, medium: 1, low: 0, info: 1, total: 3, max: "high" },
      returncode: 0,
      error: null,
      submitted_at: "2026-06-05T12:00:00",
      started_at: "2026-06-05T12:00:01",
      finished_at: "2026-06-05T12:00:45",
    },
    {
      id: "job-002",
      audit_type: "nmap-vuln",
      type: "nmap-vuln",
      target: "10.0.0.5",
      note: "nmap vuln scan",
      remote: true,
      status: "success",
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0, max: null },
      returncode: 0,
      error: null,
      submitted_at: "2026-06-05T11:30:00",
      started_at: "2026-06-05T11:30:05",
      finished_at: "2026-06-05T11:42:00",
    },
  ],
});

// ─── Mock context factory ──────────────────────────────────────────────────

function mockContext(engaged = true): WarlockContextValue {
  const fixture = makeStatus(engaged);
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/server_audit/status")) return fixture as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({})),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("ServerAudit screen", () => {
  it("renders audit jobs and findings when engaged", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(true)}>
        <ServerAudit />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("IDLE"));

    const frame = lastFrame()!;
    expect(frame).toContain("13 SRV-AUD");
    expect(frame).toContain("Server Audit");
    expect(frame).toContain("QUEUE");
    expect(frame).toContain("SUCCESS");
    expect(frame).toContain("FINDINGS");
    expect(frame).toContain("ENGAGEMENT");
    expect(frame).toContain("lynis");           // audit type in jobs table
    expect(frame).toContain("localhost");       // target
    expect(frame).toContain("nmap-vuln");       // second job type
    expect(frame).toContain("AUDIT JOBS");
    // FINDINGS summary tile shows the worst-severity total from the latest job (lynis: 3 findings, max=high)
    // NOTE: findings *panel* is hidden at the test's fallback 24-row terminal (no room after jobs table).
    // The summary tile is always shown; verify it carries live data.
    expect(frame).toContain("3");    // latestSummary.total
    expect(frame).toContain("high"); // latestSummary.max

    unmount();
  });

  it("shows engagement gate warning when not engaged", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(false)}>
        <ServerAudit />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGEMENT OFF"));

    const frame = lastFrame()!;
    expect(frame).toContain("! ENGAGEMENT OFF");
    // Engagement tile shows OFF
    expect(frame).toContain("OFF");
    expect(frame).toContain("remote gated");

    unmount();
  });

  it("caps job list with +N more when jobs exceed the 24-row body budget", async () => {
    // At fallback termRows=24 → bodyBudget=16, showTools=false (16<20).
    // engaged=true → FIXED_ROWS=6, dynamicBudget=10, maxJobs=6.
    // With 10 jobs: hasMoreJobs → displayJobs = 5 jobs + "+5 more jobs…"
    const manyJobs = Array.from({ length: 10 }, (_, i) => ({
      id: `job-cap-${i}`,
      audit_type: "nmap-vuln",
      type: "nmap-vuln",
      target: `10.0.0.${i + 1}`,
      note: "nmap scan",
      remote: true,
      status: "success",
      findings: [] as { severity: string; title: string; detail: string; target: string }[],
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0, max: null as string | null },
      returncode: 0,
      error: null as string | null,
      submitted_at: "2026-06-05T10:00:00",
      started_at: "2026-06-05T10:00:01",
      finished_at: "2026-06-05T10:00:45",
    }));

    const fixture = {
      ...makeStatus(true),
      jobs: manyJobs,
      counts: { queued: 0, running: 0, success: 10, failed: 0, cancelled: 0, error: 0, unavailable: 0, total: 10 },
    };

    const api: ApiClient = {
      baseUrl: "http://test",
      get: vi.fn(async (path: string) => {
        if (path.includes("/api/server_audit/status")) return fixture as unknown;
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({})),
    };
    const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
    const ctx: WarlockContextValue = { config: { apiUrl: "http://test", auth: null }, api, bus };

    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <ServerAudit />
      </WarlockProvider>,
    );

    // Wait for the +N more indicator to appear (list capped)
    await vi.waitFor(() => expect(lastFrame()).toMatch(/\+\d+\s*more/));

    const frame = lastFrame()!;
    expect(frame).toContain("10.0.0.1");       // first job target visible
    expect(frame).not.toContain("10.0.0.10");  // last job target hidden by cap
    expect(frame).toMatch(/\+\d+\s*more/);    // truncation indicator present

    unmount();
  });

  it("shows LINK ERROR tile when the endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("503 unavailable"));

    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <ServerAudit />
      </WarlockProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("server_audit error");

    unmount();
  });
});
