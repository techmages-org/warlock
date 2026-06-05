// Reusable data hooks for screens. usePoll() is the standard "fetch on an
// interval, expose {data, error, loading}" pattern every screen uses — it
// mirrors the web pages' useEffect+setInterval loop but lives in one place so
// downstream workers don't reinvent it.

import { useEffect, useState } from "react";

export type PollState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

// Poll `fetcher` every `intervalMs`. `deps` re-arms the loop when they change.
// The fetcher is given an AbortSignal-free contract; we guard against setting
// state after unmount with an `alive` flag.
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs = 2000,
  deps: unknown[] = [],
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetcher();
        if (alive) {
          setData(r);
          setError(null);
          setLoading(false);
        }
      } catch (e: unknown) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}
