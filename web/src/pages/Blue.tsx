import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, StatusLED, Tile } from "../components/hud";

type Detection = {
  type: "rogue_ap" | "evil_twin" | "deauth_flood" | "kismet_alert";
  severity: "high" | "medium" | "low" | "info";
  bssid: string;
  ssid: string;
  channel: number | null;
  signal: number | null;
  detail: string;
  first_seen: string | null;
  last_seen: string | null;
  source: string;
};

type DetectionResp = {
  ok: boolean;
  running: boolean;
  count: number;
  counts: {
    rogue_ap: number;
    evil_twin: number;
    deauth_flood: number;
    kismet_alert: number;
  };
  detections: Detection[];
  errors: string[];
};

type Status = {
  ok: boolean;
  running: boolean;
  iface: string | null;
  channels: string | null;
  kismet_reachable: boolean;
  uptime_s: number | null;
  started_at: string | null;
  allowlist: { ssids: number; bssids: number };
};

type Allowlist = { ok: boolean; ssids: string[]; bssids: string[] };

type Tab = "detections" | "allowlist" | "control";

const TABS: { id: Tab; label: string }[] = [
  { id: "detections", label: "Detections" },
  { id: "allowlist", label: "Allowlist" },
  { id: "control", label: "Control" },
];

const TYPE_LABEL: Record<Detection["type"], string> = {
  rogue_ap: "ROGUE AP",
  evil_twin: "EVIL TWIN",
  deauth_flood: "DEAUTH FLOOD",
  kismet_alert: "KISMET ALERT",
};

function sevColor(sev: Detection["severity"]): string {
  if (sev === "high") return "text-pink-alert";
  if (sev === "medium") return "text-amber-base";
  if (sev === "low") return "text-cyan-signal";
  return "text-txt-dim";
}

export function Blue() {
  const [tab, setTab] = useState<Tab>("detections");
  const [status, setStatus] = useState<Status | null>(null);
  const [det, setDet] = useState<DetectionResp | null>(null);
  const [note, setNote] = useState("");
  const [channels, setChannels] = useState("all");

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiGet<Status>("/api/wireless_ids/status"));
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (tab !== "detections") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<DetectionResp>("/api/wireless_ids/detections");
        if (alive) setDet(d);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  const running = !!status?.running;
  const stateLabel = status == null ? "ACQUIRING" : running ? "MONITORING" : "IDLE";
  const highCount =
    (det?.counts.evil_twin ?? 0) + (det?.counts.deauth_flood ?? 0);

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="14 BLUE-IDS"
        title="Wireless IDS"
        state={stateLabel}
        icon="🛡"
        right={
          <span className="hud-label text-txt-dim">
            {status?.iface ?? "—"} · {det?.count ?? 0} detections
          </span>
        }
      />

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="hud-btn"
            data-active={tab === t.id ? "true" : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {note && <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="STATE" led={running ? "mint" : "amber"}>
          <BigValue value={running ? "WATCH" : "IDLE"} color={running ? "mint" : "amber"} size="md" />
        </Tile>
        <Tile title="KISMET" led={status?.kismet_reachable ? "mint" : "dim"}>
          <BigValue
            value={status?.kismet_reachable ? "UP" : "—"}
            color={status?.kismet_reachable ? "mint" : "violet"}
            size="md"
          />
        </Tile>
        <Tile title="THREATS" led={highCount > 0 ? "pink" : "mint"}>
          <BigValue value={String(highCount)} color={highCount > 0 ? "pink" : "mint"} />
        </Tile>
        <Tile title="ROGUE/UNK">
          <BigValue value={String(det?.counts.rogue_ap ?? 0)} color="amber" />
        </Tile>
      </div>

      {tab === "detections" && <DetectionsTab det={det} />}
      {tab === "allowlist" && <AllowlistTab onSaved={() => { refresh(); setNote("allowlist saved"); }} />}
      {tab === "control" && (
        <ControlTab
          running={running}
          channels={channels}
          setChannels={setChannels}
          onStart={async () => {
            try {
              await apiPost("/api/wireless_ids/start", { channels });
              setNote("started — kismet monitoring on mon0");
            } catch (e) { setNote(`start failed: ${e}`); }
            refresh();
          }}
          onStop={async () => {
            try {
              await apiPost("/api/wireless_ids/stop");
              setNote("stopped — radio returned to managed");
            } catch (e) { setNote(`stop failed: ${e}`); }
            refresh();
          }}
        />
      )}
    </div>
  );
}

function DetectionsTab({ det }: { det: DetectionResp | null }) {
  const rows = det?.detections ?? [];
  return (
    <Tile title="DETECTIONS" padded={false} led={rows.some(r => r.severity === "high") ? "pink" : rows.length ? "amber" : "mint"}>
      {det?.errors?.length ? (
        <div className="border-b border-line-dim px-3 py-2 text-amber-base text-[0.75rem]">
          kismet REST: {det.errors.join("; ")}
        </div>
      ) : null}
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">SEV</th>
              <th className="hud-label px-3 py-2 text-left">Type</th>
              <th className="hud-label px-3 py-2 text-left">BSSID</th>
              <th className="hud-label px-3 py-2 text-left">SSID</th>
              <th className="hud-label px-3 py-2 text-left">CH</th>
              <th className="hud-label px-3 py-2 text-left">Detail</th>
              <th className="hud-label px-3 py-2 text-left">Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-4 text-txt-dim">
                no detections — start monitoring and set an SSID allowlist
              </td></tr>
            )}
            {rows.slice(0, 300).map((d, i) => (
              <tr key={`${d.type}-${d.bssid}-${i}`} className="border-b border-line-dim/40">
                <td className={`px-3 py-1 hud-label ${sevColor(d.severity)}`}>{d.severity.toUpperCase()}</td>
                <td className="px-3 py-1 text-violet-bright">{TYPE_LABEL[d.type] ?? d.type}</td>
                <td className="px-3 py-1 tabular-nums text-txt-body">{d.bssid || "—"}</td>
                <td className="px-3 py-1 text-txt-body">{d.ssid || <span className="text-txt-dim">—</span>}</td>
                <td className="px-3 py-1 tabular-nums text-txt-dim">{d.channel ?? "?"}</td>
                <td className="px-3 py-1 text-txt-dim">{d.detail}</td>
                <td className="px-3 py-1 text-txt-dim tabular-nums">{d.last_seen?.slice(11, 19) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function AllowlistTab({ onSaved }: { onSaved: () => void }) {
  const [ssids, setSsids] = useState("");
  const [bssids, setBssids] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiGet<Allowlist>("/api/wireless_ids/allowlist")
      .then((d) => {
        setSsids((d.ssids || []).join("\n"));
        setBssids((d.bssids || []).join("\n"));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    const toList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    try {
      await apiPost("/api/wireless_ids/allowlist", {
        ssids: toList(ssids),
        bssids: toList(bssids),
      });
      onSaved();
    } catch { /**/ }
  };

  return (
    <Tile title="TRUSTED ALLOWLIST" led="violet">
      <div className="space-y-3">
        <div className="text-txt-dim text-[0.75rem]">
          SSIDs you operate. APs broadcasting an SSID <em>not</em> on this list are flagged{" "}
          <span className="text-amber-base">rogue/unknown</span>. An allowlisted SSID seen from an
          unrecognized BSSID (or from multiple BSSIDs) is flagged{" "}
          <span className="text-pink-alert">evil-twin</span>. An empty list disables rogue flagging
          (monitor-only). Optionally pin trusted BSSIDs to tighten evil-twin detection.
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="hud-label block mb-1">Trusted SSIDs (one per line)</label>
            <textarea
              className="hud-tile w-full bg-bg-strip px-2 py-1 text-txt-body font-mono text-[0.8125rem]"
              rows={6}
              value={ssids}
              onChange={(e) => setSsids(e.target.value)}
              placeholder="CorpNet&#10;GuestWiFi"
              disabled={!loaded}
            />
          </div>
          <div>
            <label className="hud-label block mb-1">Trusted BSSIDs (optional)</label>
            <textarea
              className="hud-tile w-full bg-bg-strip px-2 py-1 text-txt-body font-mono text-[0.8125rem]"
              rows={6}
              value={bssids}
              onChange={(e) => setBssids(e.target.value)}
              placeholder="aa:bb:cc:00:11:22"
              disabled={!loaded}
            />
          </div>
        </div>
        <button className="hud-btn border-mint-safe text-mint-safe" onClick={save} disabled={!loaded}>
          ✓ SAVE ALLOWLIST
        </button>
      </div>
    </Tile>
  );
}

function ControlTab({
  running,
  channels,
  setChannels,
  onStart,
  onStop,
}: {
  running: boolean;
  channels: string;
  setChannels: (s: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const options = [
    { v: "all", l: "All channels (hop)" },
    { v: "1,6,11", l: "2.4 GHz — 1/6/11" },
    { v: "36,40,44,48", l: "5 GHz — low" },
  ];
  return (
    <Tile title="MONITOR CONTROL" led={running ? "mint" : "violet"}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <StatusLED color={running ? "mint" : "dim"} />
          <span className="text-txt-body">
            {running ? "kismet monitoring on mon0" : "idle — ready to start"}
          </span>
        </div>

        <div>
          <label className="hud-label block mb-1">Channels</label>
          <div className="flex flex-wrap gap-2">
            {options.map((o) => (
              <label key={o.v} className="hud-btn cursor-pointer">
                <input
                  type="radio"
                  name="chan"
                  value={o.v}
                  checked={channels === o.v}
                  onChange={() => setChannels(o.v)}
                  className="mr-2 accent-amber-base"
                />
                {o.l}
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            className="hud-btn border-mint-safe text-mint-safe disabled:opacity-40"
            onClick={onStart}
            disabled={running}
          >
            ▶ START IDS
          </button>
          <button
            className="hud-btn border-pink-alert text-pink-alert disabled:opacity-40"
            onClick={onStop}
            disabled={!running}
          >
            ■ STOP IDS
          </button>
        </div>

        <div className="text-txt-dim text-[0.75rem]">
          Start puts the MT7921 USB dongle into monitor mode via{" "}
          <code className="text-violet-bright">wlan-mt7921 monitor</code>, then launches{" "}
          <code className="text-violet-bright">kismet</code> headless. Detections are read passively
          from kismet's REST API (devices + alert engine) — no injection, no engagement gate. Stop
          returns the radio to managed mode.
        </div>
      </div>
    </Tile>
  );
}
