// Minimal reconnecting WS helper for the /ws event bus.

export type WireEvent = { name: string; payload: Record<string, unknown>; ts: string };

export function openEventBus(onEvent: (evt: WireEvent) => void): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;

  const connect = () => {
    if (stopped) return;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${window.location.host}/ws`);
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as WireEvent;
        onEvent(e);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (!stopped) setTimeout(connect, 2000);
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return () => {
    stopped = true;
    ws?.close();
  };
}
