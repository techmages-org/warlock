// ChatApp test — mock the agent runner (no live LLM). Assert: a typed question
// commits its answer to the <Static> log (which lastFrame includes), a long
// answer renders without throwing, runner failures commit an error entry, and
// an unconfigured provider shows the hint.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner, AskOptions } from "../lib/agent.js";
import { ChatApp } from "./ChatApp.js";

const ENTER = "\r";
// Ink attaches its raw-stdin listener a tick after mount; the first keystroke
// written before that is dropped. Settle once so the first input lands.
const settle = () => new Promise<void>((r) => setTimeout(r, 80));

function renderChat(runner: AgentRunner, missing: string[] = []) {
  return render(<ChatApp runner={runner} model="glm-4.6" missing={missing} />);
}

describe("ChatApp (standalone warlock-chat)", () => {
  it("renders the static header with the model + read-only label", () => {
    const { lastFrame, unmount } = renderChat({ ask: async () => "" });
    const frame = lastFrame()!;
    expect(frame).toContain("WaRL0c Assistant");
    expect(frame).toContain("read-only");
    expect(frame).toContain("glm-4.6");
    expect(frame).toContain("ask the deck");
    unmount();
  });

  it("commits a typed question + grounded answer to the scrollback log", async () => {
    const seen: string[] = [];
    const runner: AgentRunner = {
      ask: async (q: string, opts?: AskOptions) => {
        seen.push(q);
        opts?.onToolCall?.("dashboard_status");
        return "CPU 12%, no engagement active.";
      },
    };
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("how is the deck?");
    await vi.waitFor(() => expect(lastFrame()).toContain("how is the deck?"));
    stdin.write(ENTER);

    // On completion the exchange is committed to <Static> (present in lastFrame).
    await vi.waitFor(() => expect(lastFrame()).toContain("CPU 12%, no engagement active."));
    const frame = lastFrame()!;
    expect(seen).toEqual(["how is the deck?"]);
    expect(frame).toContain("how is the deck?"); // user line committed too
    expect(frame).toContain("you");
    expect(frame).toContain("war");
    unmount();
  });

  it("renders a long answer without throwing (Static → scrollback, no frame clear)", async () => {
    const long = "A".repeat(6000);
    const runner: AgentRunner = { ask: async () => long };
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("dump everything");
    await vi.waitFor(() => expect(lastFrame()).toContain("dump everything"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("AAAAAAAAAA"));
    expect(() => lastFrame()).not.toThrow();
    unmount();
  });

  it("commits an error entry when the runner fails", async () => {
    const runner: AgentRunner = {
      ask: async () => {
        throw new Error("provider 401 unauthorized");
      },
    };
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("status?");
    await vi.waitFor(() => expect(lastFrame()).toContain("status?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("provider 401 unauthorized"));
    expect(lastFrame()).toContain("err");
    unmount();
  });

  it("shows the configure hint when provider env is unset, and still renders the prompt", () => {
    const { lastFrame, unmount } = renderChat({ ask: async () => "" }, ["WARLOCK_AGENT_API_KEY"]);
    const frame = lastFrame()!;
    expect(frame).toContain("provider not configured");
    expect(frame).toContain("WARLOCK_AGENT_API_KEY");
    expect(frame).toContain("/opt/warlock/agent.env");
    expect(frame).toContain("ask the deck");
    unmount();
  });
});
