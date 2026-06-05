// Crack screen test — mirrors dashboard.test.tsx: mock the api client, wrap in
// WarlockProvider, await the polled load, assert the live frame + an error
// frame, the cursor-selected submit, AND geometry: a long jobs list is bounded
// to a scrolling window with a "+N more" indicator (default ITL terminal = 24x120).

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as Crack } from "./crack.js";

const ESC = String.fromCharCode(27);
const RIGHT = ESC + "[C";
const TAB = "\t";

function job(i: number) {
  return {
    id: `job${String(i).padStart(4, "0")}`,
    hashfile: `/cap/h${i}.hc22000`,
    hashfile_name: `h${i}.hc22000`,
    wordlist_name: "rockyou.txt",
    mode: "22000",
    status: i === 0 ? "running" : "queued",
    progress: 0,
    speed_hs: 0,
    recovered: null,
    cracked: null,
    error: null,
  };
}

function makeStatus(jobCount: number, engaged = true) {
  return {
    ok: true,
    engaged,
    requires_engagement: true,
    hashcat: { path: "/usr/bin/hashcat", present: true },
    modes: ["22000", "16800"],
    counts: { queued: jobCount, running: 0, cracked: 0, total: jobCount },
    hashfiles: [
      { filename: "pmkid-AABBCCDDEEFF.hc22000", path: "/cap/pmkid-AABBCCDDEEFF.hc22000", size_bytes: 2048 },
      { filename: "hs-112233445566.hc22000", path: "/cap/hs-112233445566.hc22000", size_bytes: 4096 },
    ],
    wordlists: [{ filename: "rockyou.txt", path: "/wl/rockyou.txt", size_bytes: 139_921_507 }],
    jobs: Array.from({ length: jobCount }, (_, i) => job(i)),
  };
}

function mockContext(jobCount = 1, engaged = true): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async (path: string) => {
      if (path.includes("/api/crack/status")) return makeStatus(jobCount, engaged) as unknown;
      throw new Error(`unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ job_id: "feedface0000" })),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

describe("Crack screen", () => {
  it("renders the CONFIG panel + stat strip after the polled load", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext()}>
        <Crack />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rockyou.txt"));
    const frame = lastFrame()!;
    expect(frame).toContain("Crack Queue");
    expect(frame).toContain("SUBMIT CRACK JOB");
    expect(frame).toContain("READY"); // hashcat in stat strip
    expect(frame).toContain("pmkid-AABBCCDDEEFF.hc22000");
    unmount();
  });

  it("shows the engagement gate when engagement is off", async () => {
    const { lastFrame, unmount } = render(
      <WarlockProvider value={mockContext(1, false)}>
        <Crack />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("ENGAGEMENT OFF"));
    expect(lastFrame()).toContain("!");
    unmount();
  });

  it("submits the cursor-selected hashfile when 's' is pressed", async () => {
    const ctx = mockContext();
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={ctx}>
        <Crack />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rockyou.txt"));
    stdin.write(RIGHT); // cycle hashfile cursor to the 2nd file
    await vi.waitFor(() => expect(lastFrame()).toContain("[2/2]"));
    stdin.write("s");
    await vi.waitFor(() => expect(ctx.api.post as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    expect(ctx.api.post).toHaveBeenCalledWith(
      "/api/crack/jobs",
      expect.objectContaining({ hashfile: "/cap/hs-112233445566.hc22000", mode: "22000" }),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("queued job feedface"));
    unmount();
  });

  it("bounds a long jobs list to a scrolling window with +N more", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WarlockProvider value={mockContext(20)}>
        <Crack />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("rockyou.txt"));
    stdin.write(TAB); // → JOBS panel
    await vi.waitFor(() => expect(lastFrame()).toContain("CRACK JOBS (20)"));
    const frame = lastFrame()!;
    expect(frame).toMatch(/\+\d+ more/); // overflow indicator
    expect(frame).toContain("/20)"); // scroll position
    // Not all 20 rows rendered — the window is bounded.
    const shown = (frame.match(/\.hc22000/g) ?? []).length;
    expect(shown).toBeLessThan(20);
    // Verified bounded: total body height fits the 24-row budget (rows - chrome 8).
    const lines = frame.split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    expect(lines.length).toBeLessThanOrEqual(16);
    unmount();
  });

  it("shows an error tile when the endpoint fails", async () => {
    const ctx = mockContext();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { lastFrame, unmount } = render(
      <WarlockProvider value={ctx}>
        <Crack />
      </WarlockProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("LINK ERROR"));
    expect(lastFrame()).toContain("crack error");
    unmount();
  });
});
