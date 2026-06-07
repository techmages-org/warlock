// Agent POINTER screen test. The interactive chat moved to the standalone
// `warlock-chat` app (see chat/ChatApp.test.tsx); this embedded screen is now a
// static signpost, so it needs no provider/runner mock and no input driving.

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Screen as Agent } from "./agent.js";

describe("Agent pointer screen", () => {
  it("points the operator to the standalone warlock-chat app", () => {
    const { lastFrame, unmount } = render(<Agent />);
    const frame = lastFrame()!;
    expect(frame).toContain("WaRL0c Assistant");
    expect(frame).toContain("warlock-chat");
    expect(frame).toMatch(/own app|standalone|separate/i);
    unmount();
  });
});
