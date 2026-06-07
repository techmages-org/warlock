// ChatApp test — the flood-fix behavior. Mock the runner (no live LLM). Assert:
// banner prints once, one turn commits exactly one exchange, the growing answer
// is NOT live-rendered (only the braille spinner shows in-flight), and the slash
// menu opens on "/" + a command runs.

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner, AskOptions } from "../lib/agent.js";
import { ChatApp } from "./ChatApp.js";

const ENTER = "\r";
const BRAILLE = /[⠀-⣿]/; // unicode-animations spinner frames (U+2800 block)
const settle = () => new Promise<void>((r) => setTimeout(r, 80));
const count = (s: string, sub: string) => s.split(sub).length - 1;

function renderChat(runner: AgentRunner, missing: string[] = []) {
  return render(<ChatApp runner={runner} provider="zai" model="glm-4.6" missing={missing} />);
}

describe("ChatApp flood-fix", () => {
  it("prints the banner/header/welcome once with a status footer", () => {
    const { lastFrame, unmount } = renderChat({ ask: async () => "" });
    const frame = lastFrame()!;
    expect(count(frame, "cyberdeck assistant")).toBe(1); // banner once
    expect(frame).toContain("WaRL0c Assistant");
    expect(frame).toContain("v0.1.0");
    expect(frame).toContain("zai:glm-4.6");
    expect(frame).toContain("Wi-Fi"); // capability welcome
    expect(frame).toContain("Ctrl+C quit"); // footer
    expect(frame).toContain("ready");
    unmount();
  });

  it("commits exactly one exchange per turn (no stacked copies)", async () => {
    const runner: AgentRunner = { ask: async () => "UNIQ-ANSWER-SENTINEL ok" };
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("how are you?");
    await vi.waitFor(() => expect(lastFrame()).toContain("how are you?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("UNIQ-ANSWER-SENTINEL"));
    const frame = lastFrame()!;
    expect(count(frame, "UNIQ-ANSWER-SENTINEL")).toBe(1); // committed once
    expect(count(frame, "how are you?")).toBe(1); // question once
    expect(frame).toContain("1 turn"); // footer turn count
    unmount();
  });

  it("does NOT live-render the growing answer in-flight — only the braille spinner", async () => {
    let resolveAsk!: (v: string) => void;
    const pending = new Promise<string>((res) => {
      resolveAsk = res;
    });
    const runner: AgentRunner = {
      ask: (_q: string, opts?: AskOptions) => {
        opts?.onToolCall?.("dashboard_status");
        return pending;
      },
    };
    const { lastFrame, stdin, unmount } = renderChat(runner);

    await settle();
    stdin.write("status?");
    await vi.waitFor(() => expect(lastFrame()).toContain("status?"));
    stdin.write(ENTER);

    await vi.waitFor(() => expect(lastFrame()).toContain("reading dashboard_status"));
    const midFrame = lastFrame()!;
    expect(midFrame).toMatch(BRAILLE); // animated spinner present
    expect(midFrame).not.toContain("LATE-ANSWER"); // answer NOT live-rendered

    resolveAsk("LATE-ANSWER committed");
    await vi.waitFor(() => expect(lastFrame()).toContain("LATE-ANSWER committed"));
    expect(count(lastFrame()!, "LATE-ANSWER committed")).toBe(1);
    unmount();
  });

  it("opens the slash menu on / and runs a selected command", async () => {
    const { lastFrame, stdin, unmount } = renderChat({ ask: async () => "should not run" });

    await settle();
    stdin.write("/");
    await vi.waitFor(() => expect(lastFrame()).toContain("/help"));
    const menu = lastFrame()!;
    expect(menu).toContain("/tools");
    expect(menu).toContain("/clear");
    expect(menu).toContain("show available commands");

    // With just "/" typed, the first match (/help) is selected → Enter runs it.
    stdin.write(ENTER);
    await vi.waitFor(() => expect(lastFrame()).toContain("just type a question"));
    expect(lastFrame()).not.toContain("should not run"); // command, not an agent ask
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

  it("shows the configure hint in the header when provider env is unset", () => {
    const { lastFrame, unmount } = renderChat({ ask: async () => "" }, ["WARLOCK_AGENT_API_KEY"]);
    const frame = lastFrame()!;
    expect(frame).toContain("WARLOCK_AGENT_API_KEY");
    expect(frame).toContain("/opt/warlock/agent.env");
    unmount();
  });
});
