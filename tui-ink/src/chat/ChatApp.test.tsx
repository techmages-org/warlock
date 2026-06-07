// ChatApp test — mock the agent runner (no live LLM). Assert the W1 glow-up:
// branded banner + capability welcome render, answers render as MARKDOWN (not
// raw **/|---|), the animated braille indicator shows while a turn is in-flight,
// the status footer is present, plus the commit path / error / config hint.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner, AskOptions } from "../lib/agent.js";
import { ChatApp } from "./ChatApp.js";

const ENTER = "\r";
const BRAILLE = /[⠀-⣿]/; // unicode-animations frames live in this block
// Ink attaches its raw-stdin listener a tick after mount; the first keystroke
// written before that is dropped. Settle once so the first input lands.
const settle = () => new Promise<void>((r) => setTimeout(r, 80));

function renderChat(runner: AgentRunner, missing: string[] = []) {
  return render(<ChatApp runner={runner} provider="zai" model="glm-4.6" missing={missing} />);
}

describe("ChatApp (Hermes-grade warlock-chat)", () => {
  it("renders the branded banner, capability welcome, titled header + status footer", () => {
    const { lastFrame, unmount } = renderChat({ ask: async () => "" });
    const frame = lastFrame()!;
    // banner splash
    expect(frame).toContain("cyberdeck assistant");
    // capability welcome (derived from READ_ENDPOINTS groups)
    expect(frame).toContain("read this deck's live state");
    expect(frame).toContain("Wi-Fi");
    // titled header
    expect(frame).toContain("WaRL0c Assistant");
    expect(frame).toContain("v0.1.0");
    expect(frame).toContain("zai:glm-4.6");
    expect(frame).toContain("read-only");
    // status footer
    expect(frame).toContain("Ctrl+C quit");
    expect(frame).toContain("ready");
    unmount();
  });

  it("renders the answer as MARKDOWN (bold + list), not raw markup", async () => {
    const runner: AgentRunner = {
      ask: async () => "Here is **bold** status\n- item one\n- item two",
    };
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("status?");
    await vi.waitFor(() => expect(lastFrame()).toContain("status?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("bold status"));
    const frame = lastFrame()!;
    expect(frame).not.toContain("**"); // bold markup rendered, not raw
    expect(frame).toContain("• item one"); // bullet rendered
    expect(frame).toContain("• item two");
    expect(frame).toContain("1 turn"); // status footer turn count updated
    unmount();
  });

  it("shows the animated braille indicator + tool label while a turn is in-flight", async () => {
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
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("how many mesh nodes?");
    await vi.waitFor(() => expect(lastFrame()).toContain("how many mesh nodes?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("reading mesh_nodes"));
    expect(lastFrame()).toMatch(BRAILLE); // animated braille glyph present

    resolveAsk("3 nodes visible.");
    await vi.waitFor(() => expect(lastFrame()).toContain("3 nodes visible."));
    unmount();
  });

  it("renders a long answer without throwing (Static → scrollback)", async () => {
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

  it("shows the configure hint when provider env is unset", () => {
    const { lastFrame, unmount } = renderChat({ ask: async () => "" }, ["WARLOCK_AGENT_API_KEY"]);
    const frame = lastFrame()!;
    expect(frame).toContain("WARLOCK_AGENT_API_KEY");
    expect(frame).toContain("/opt/warlock/agent.env");
    expect(frame).toContain("ask the deck");
    unmount();
  });
});
