// Data-layer unit tests: the Basic-auth header is built correctly, the client
// attaches it to every request, and the CLI config parser works.

import { afterEach, describe, expect, it, vi } from "vitest";
import { basicAuthHeader, createApiClient } from "../lib/api.js";
import { parseConfig } from "../lib/config.js";

describe("basicAuthHeader", () => {
  it("builds Basic base64(user:password)", () => {
    // base64("user:pass") === "dXNlcjpwYXNz"
    expect(basicAuthHeader({ user: "user", password: "pass" })).toBe(
      "Basic dXNlcjpwYXNz",
    );
  });

  it("returns undefined with no credentials", () => {
    expect(basicAuthHeader(null)).toBeUndefined();
  });
});

describe("createApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the Authorization header and resolves JSON on GET", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const api = createApiClient({
      apiUrl: "http://deck:7777",
      auth: { user: "user", password: "pass" },
    });
    const body = await api.get<{ ok: boolean }>("/api/health");

    expect(body).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://deck:7777/api/health");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Basic dXNlcjpwYXNz");
  });

  it("throws on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    const api = createApiClient({ apiUrl: "http://deck:7777", auth: null });
    await expect(api.get("/api/modules")).rejects.toThrow(/401/);
  });
});

describe("parseConfig", () => {
  it("defaults apiUrl and yields null auth when creds absent", () => {
    expect(parseConfig([])).toEqual({ apiUrl: "http://127.0.0.1:7777", auth: null });
  });

  it("parses --api/--user/--password and strips trailing slash", () => {
    const c = parseConfig([
      "--api",
      "http://deck:7777/",
      "--user",
      "user",
      "--password",
      "pass",
    ]);
    expect(c.apiUrl).toBe("http://deck:7777");
    expect(c.auth).toEqual({ user: "user", password: "pass" });
  });

  it("accepts --key=value form", () => {
    const c = parseConfig(["--api=http://x:1", "--user=u", "--password=p"]);
    expect(c.apiUrl).toBe("http://x:1");
    expect(c.auth).toEqual({ user: "u", password: "p" });
  });
});
