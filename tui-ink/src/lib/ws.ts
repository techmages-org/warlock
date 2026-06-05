// Reconnecting WS client for the /ws event bus.
//
// Uses the `ws` npm package (Node has no global browser WebSocket / window).
// Base URL + auth come from config — http(s):// is rewritten to ws(s)://, and
// the Basic credential is sent as an Authorization header on the upgrade
// request. Reconnects with a fixed backoff like the web helper.

import WebSocket from "ws";
import { basicAuthHeader } from "./api.js";
import type { Config } from "./config.js";
import type { WireEvent } from "./types.js";

export type EventBus = {
  // Subscribe to every wire event. Returns an unsubscribe fn.
  subscribe(handler: (evt: WireEvent) => void): () => void;
  // Tear the bus down for good (stops reconnecting, closes the socket).
  close(): void;
};

function wsUrl(apiUrl: string): string {
  return apiUrl.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`) + "/ws";
}

export function createEventBus(config: Config, backoffMs = 2000): EventBus {
  const handlers = new Set<(evt: WireEvent) => void>();
  let stopped = false;
  let socket: WebSocket | null = null;

  const authHeader = basicAuthHeader(config.auth);
  const headers = authHeader ? { Authorization: authHeader } : undefined;

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(wsUrl(config.apiUrl), { headers });
    socket = sock;
    sock.on("message", (data: WebSocket.RawData) => {
      try {
        const evt = JSON.parse(data.toString()) as WireEvent;
        for (const h of handlers) h(evt);
      } catch {
        /* ignore malformed frames */
      }
    });
    sock.on("close", () => {
      if (!stopped) setTimeout(connect, backoffMs);
    });
    // Swallow errors — the close handler drives reconnection.
    sock.on("error", () => sock.close());
  };

  connect();

  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      stopped = true;
      handlers.clear();
      socket?.close();
    },
  };
}
