// Agent chat screen test — mocks the PROVIDER by injecting a fake AgentRunner
// (the `makeRunner` prop). No live LLM, no real PI loop here (that's proven in
// lib/agent.test.ts). We assert: a typed question renders a grounded answer,
// the "thinking" indicator shows while the runner is in flight, and a runner
// failure renders an error message.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WarlockProvider, type WarlockContextValue } from "../context.js";
import type { AgentRunner, AskOptions } from "../lib/agent.js";
import type { ApiClient } from "../lib/api.js";
import type { EventBus } from "../lib/ws.js";
import { Screen as Agent } from "./agent.js";

const ENTER = "\r";

// Ink attaches its raw-stdin listener a tick after mount; the very first
// keystroke written before that is dropped. Settle once after mount so the
// first real input lands (other screens dodge this via their initial poll await).
const settle = () => new Promise<void>((r) => setTimeout(r, 80));

// The screen talks to the runner, never the api directly — but post() throws to
// keep the read-only guarantee honest if that ever changes.
function mockContext(): WarlockContextValue {
  const api: ApiClient = {
    baseUrl: "http://test",
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => {
      throw new Error("read-only screen must never POST");
    }),
  };
  const bus: EventBus = { subscribe: () => () => {}, close: () => {} };
  return { config: { apiUrl: "http://test", auth: null }, api, bus };
}

function renderAgent(runner: AgentRunner) {
  return render(
    <WarlockProvider value={mockContext()}>
      <Agent makeRunner={() => runner} />
    </WarlockProvider>,
  );
}

describe("Agent chat screen", () => {
  it("renders the intro + header before any question", () => {
    const { lastFrame, unmount } = renderAgent({ ask: async () => "" });
    const frame = lastFrame()!;
    expect(frame).toContain("WaRL0c Assistant");
    expect(frame).toContain("READY");
    expect(frame).toContain("Ask about the live deck");
    expect(frame).toContain("Esc dashboard");
    unmount();
  });

  it("answers a typed question with the grounded reply and tool activity", async () => {
    const seen: string[] = [];
    const runner: AgentRunner = {
      ask: async (q: string, opts?: AskOptions) => {
        seen.push(q);
        opts?.onToolCall?.("dashboard_status");
        return "CPU 12%, no engagement active.";
      },
    };
    const { lastFrame, stdin, unmount } = renderAgent(runner);

    // Wait for the input box to mount so Ink has attached its stdin listener.
    await vi.waitFor(() => expect(lastFrame()).toContain("ask the deck"));
    await settle();
    stdin.write("how is the deck?");
    await vi.waitFor(() => expect(lastFrame()).toContain("how is the deck?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("CPU 12%, no engagement active."));
    const frame = lastFrame()!;
    expect(seen).toEqual(["how is the deck?"]);
    expect(frame).toContain("you"); // user role label
    expect(frame).toContain("war"); // assistant role label
    unmount();
  });

  it("shows the thinking indicator while the agent runs, then the answer", async () => {
    let resolveAsk!: (v: string) => void;
    const pending = new Promise<string>((res) => {
      resolveAsk = res;
    });
    const runner: AgentRunner = {
      ask: (_q: string, opts?: AskOptions) => {
        opts?.onToolCall?.("mesh_nodes");
        return pending;
      },
    };
    const { lastFrame, stdin, unmount } = renderAgent(runner);

    await vi.waitFor(() => expect(lastFrame()).toContain("ask the deck"));
    await settle();
    stdin.write("how many mesh nodes?");
    await vi.waitFor(() => expect(lastFrame()).toContain("how many mesh nodes?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("thinking"));
    expect(lastFrame()).toContain("THINKING"); // header state flips
    expect(lastFrame()).toContain("reading mesh_nodes");

    resolveAsk("3 nodes visible.");
    await vi.waitFor(() => expect(lastFrame()).toContain("3 nodes visible."));
    expect(lastFrame()).toContain("READY"); // back to idle
    unmount();
  });

  it("renders an error when the runner fails", async () => {
    const runner: AgentRunner = {
      ask: async () => {
        throw new Error("provider 401 unauthorized");
      },
    };
    const { lastFrame, stdin, unmount } = renderAgent(runner);

    await vi.waitFor(() => expect(lastFrame()).toContain("ask the deck"));
    await settle();
    stdin.write("status?");
    await vi.waitFor(() => expect(lastFrame()).toContain("status?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("provider 401 unauthorized"));
    expect(lastFrame()).toContain("err"); // error role label
    unmount();
  });
});
