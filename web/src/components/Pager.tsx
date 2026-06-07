import { useEffect, useRef, useState, useCallback } from "react";
import clsx from "clsx";
import { Tile, StatusLED, type LEDColor } from "./hud";
import { apiGet } from "../lib/api";

// --------------------------------------------------------------------------- //
// Pager — the live activity / loot feed. Polls `GET /api/ops/events` and
// renders a compact, scrolling, newest-first stream of bus alerts (IDS hits,
// recon findings, scope violations) folded with recent gated-op activity.
//
// Reusable + embeddable: the Wireless page drops <Pager /> straight in. Tune
// via props; sensible phosphor-themed defaults otherwise.
// --------------------------------------------------------------------------- //

export type PagerEvent = {
  ts: string | null;
  source: string;
  severity: string;
  kind: string;
  text: string;
};

type EventsResponse = {
  ok: boolean;
  events: PagerEvent[];
  count: number;
};

// Severity → phosphor LED colour. Unknown severities fall back to violet so a
// new/odd severity still renders an icon instead of breaking the row.
function ledFor(severity: string): LEDColor {
  switch ((severity || "").toLowerCase()) {
    case "critical":
    case "high":
      return "pink";
    case "warning":
    case "medium":
      return "amber";
    case "info":
    case "low":
      return "cyan";
    default:
      return "violet";
  }
}

const TEXT_CLASS: Record<LEDColor, string> = {
  pink: "text-pink-alert",
  amber: "text-amber-bright",
  cyan: "text-cyan-signal",
  violet: "text-violet-bright",
  mint: "text-mint-safe",
  dim: "text-txt-dim",
};

// ISO (naive UTC) → HH:MM:SS for the compact timestamp gutter.
function fmtTime(ts: string | null): string {
  if (!ts) return "--:--:--";
  const t = ts.includes("T") ? ts.split("T")[1] : ts;
  return (t || "").slice(0, 8) || "--:--:--";
}

export function Pager({
  limit = 50,
  pollMs = 2500,
  audit = true,
  title = "Activity",
  className,
  bare = false,
}: {
  /** Max rows to fetch + render. */
  limit?: number;
  /** Poll interval in ms. */
  pollMs?: number;
  /** Fold recent gated-op audit rows into the feed. */
  audit?: boolean;
  /** Tile header title. */
  title?: string;
  className?: string;
  /** Render just the scrolling list, without the Tile chrome (for embedding). */
  bare?: boolean;
}) {
  const [events, setEvents] = useState<PagerEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const q = `/api/ops/events?limit=${limit}&audit=${audit ? 1 : 0}`;
      const r = await apiGet<EventsResponse>(q);
      setEvents(r.events || []);
      setErr(null);
      seen.current = true;
    } catch (e: any) {
      setErr(String(e));
    }
  }, [limit, audit]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const list = (
    <ul
      className={clsx(
        "flex flex-col gap-0.5 overflow-y-auto font-mono text-[12px] leading-snug",
        bare ? className : "max-h-72",
      )}
      aria-live="polite"
      aria-label="activity feed"
    >
      {err && (
        <li className="px-1 py-2 text-pink-alert">feed error: {err}</li>
      )}
      {!err && seen.current && events.length === 0 && (
        <li className="px-1 py-2 text-txt-dim">— no recent activity —</li>
      )}
      {events.map((e, i) => {
        const led = ledFor(e.severity);
        return (
          <li
            key={`${e.ts ?? "?"}-${i}`}
            className="flex items-baseline gap-2 px-1 py-0.5 hover:bg-bg-elev"
          >
            <span className="tabular shrink-0 text-txt-dim">{fmtTime(e.ts)}</span>
            <StatusLED color={led} size={6} className="shrink-0 translate-y-[1px]" />
            <span className="shrink-0 uppercase tracking-wide text-txt-dim">
              {e.source}
            </span>
            <span className={clsx("min-w-0 truncate", TEXT_CLASS[led])} title={e.text}>
              {e.text}
            </span>
          </li>
        );
      })}
    </ul>
  );

  if (bare) return list;

  return (
    <Tile
      title={title}
      icon="❯"
      led={events.length ? ledFor(events[0].severity) : "dim"}
      headerRight={
        <span className="hud-label tabular">{events.length}</span>
      }
      className={className}
      padded={false}
    >
      <div className="px-3 py-2">{list}</div>
    </Tile>
  );
}

export default Pager;
