// Minimal reconnecting WS helper for the /ws event bus.
//
// Auth: the FastAPI `/ws` bus can be flipped behind a token (WARLOCK_WS_AUTH).
// A browser WebSocket can't send an Authorization header, so before opening the
// socket we fetch a short-lived HMAC token from `GET /api/ws-token` (which DOES
// carry the browser's same-origin Basic credentials via `credentials:"include"`)
// and pass it as a `?token=` query param. The token is re-fetched on every
// (re)connect attempt, so its 60s TTL is covered: the server validates at the
// WS handshake, and each reconnect gets a fresh token. When the token fetch
// fails (endpoint absent, or WARLOCK_WS_AUTH is OFF) we connect bare — which the
// server accepts when auth is off, and which simply retries when it isn't.
//
// `openEventBus` keeps its original signature so existing consumers
// (EngagementBanner, the SDR view, …) are untouched.

export type WireEvent = { name: string; payload: Record<string, unknown>; ts: string };

type WsToken = { token?: string; expires_in?: number };

// Fetch a fresh WS auth token. Returns null (never throws) so a missing endpoint
// or an auth-off backend degrades to a bare connection instead of breaking.
async function fetchWsToken(): Promise<string | null> {
  try {
    const r = await fetch("/api/ws-token", { credentials: "include" });
    if (!r.ok) return null;
    const d = (await r.json()) as WsToken;
    return typeof d.token === "string" && d.token.length > 0 ? d.token : null;
  } catch {
    return null;
  }
}

export function openEventBus(onEvent: (evt: WireEvent) => void): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;

  const connect = async () => {
    if (stopped) return;
    // Pull a fresh token first; covers TTL expiry on every reconnect.
    const token = await fetchWsToken();
    if (stopped) return; // a teardown may have raced the async token fetch
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    ws = new WebSocket(`${scheme}://${window.location.host}/ws${q}`);
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as WireEvent;
        onEvent(e);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      // Reconnect (and re-fetch a token) on any close — expiry, auth reject, or
      // a dropped connection all funnel through here.
      if (!stopped) setTimeout(() => void connect(), 2000);
    };
    ws.onerror = () => ws?.close();
  };

  void connect();

  return () => {
    stopped = true;
    ws?.close();
  };
}
