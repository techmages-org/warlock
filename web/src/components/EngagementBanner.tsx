import { useEffect, useState } from "react";
import { apiGet, apiPost, type EngagementStatus } from "../lib/api";
import { openEventBus } from "../lib/ws";
import clsx from "clsx";

export function EngagementBanner() {
  const [status, setStatus] = useState<EngagementStatus>({
    mode: "loading",
    engagement_id: null,
    name: "",
    scope: { ssids: [], bssids: [], ip_ranges: [] },
    started_at: null,
  });
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const s = await apiGet<EngagementStatus>("/api/engagements/active");
      setStatus(s);
    } catch {
      setStatus((prev) => ({ ...prev, mode: "loading" }));
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    const stop = openEventBus((e) => {
      if (e.name.startsWith("engagement.") || e.name === "killswitch.pressed") refresh();
    });
    return () => {
      clearInterval(t);
      stop();
    };
  }, []);

  const killswitch = async () => {
    if (!confirm("KILL SWITCH: stop all active jobs and restore interfaces to managed mode?")) return;
    setBusy(true);
    try {
      await apiPost("/api/engagements/killswitch");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const cls = clsx(
    "w-full px-4 py-2 text-sm font-bold flex items-center justify-between sticky top-0 z-20",
    status.mode === "on" && "bg-warlock-danger text-white",
    status.mode === "off" && "bg-warlock-safe/90 text-black",
    status.mode === "loading" && "bg-warlock-warn/90 text-black",
  );

  const scopeSummary =
    status.mode === "on"
      ? `SSIDs:${status.scope.ssids.length} BSSIDs:${status.scope.bssids.length} IPs:${status.scope.ip_ranges.length}`
      : "";

  return (
    <div className={cls}>
      <div>
        {status.mode === "on"
          ? `⚠  ENGAGED — ${status.name}  [${scopeSummary}]`
          : status.mode === "off"
          ? "✓  SAFE — engagement mode OFF"
          : "… loading engagement status"}
      </div>
      <button className="wl-btn-danger bg-black/20" disabled={busy} onClick={killswitch}>
        {busy ? "…" : "KILL SWITCH"}
      </button>
    </div>
  );
}
