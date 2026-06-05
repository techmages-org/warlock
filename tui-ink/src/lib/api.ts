// API client for the Warlock FastAPI backend.
//
// Unlike the web client (which relies on the browser cookie jar +
// credentials:"include"), Node has no cookie jar — so we send an explicit
// `Authorization: Basic base64(user:password)` header on EVERY request.
// Build with createApiClient(config); screens get it from React context via
// useApi() and never construct their own.

import type { Auth, Config } from "./config.js";

// Pure, unit-testable: returns the exact `Authorization` header value, or
// undefined when no credentials were supplied.
export function basicAuthHeader(auth: Auth): string | undefined {
  if (!auth) return undefined;
  const token = Buffer.from(`${auth.user}:${auth.password}`).toString("base64");
  return `Basic ${token}`;
}

export interface ApiClient {
  readonly baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function createApiClient(config: Config): ApiClient {
  const authHeader = basicAuthHeader(config.auth);

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    if (authHeader) headers.set("Authorization", authHeader);
    const r = await fetch(joinUrl(config.apiUrl, path), { ...init, headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
    // Some endpoints (e.g. 204) return no body.
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    baseUrl: config.apiUrl,
    get<T = unknown>(path: string): Promise<T> {
      return request<T>(path, { method: "GET" });
    },
    post<T = unknown>(path: string, body?: unknown): Promise<T> {
      return request<T>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
  };
}
