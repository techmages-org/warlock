import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { ModuleHeader, Tile } from "../components/hud";

/* ---------- types ---------- */

type Engagement = {
  id: string;
  name: string;
  status: string;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  scope: { ssids: string[]; bssids: string[]; ip_ranges: string[] };
  targets_count?: number;
};

type Template = {
  id: string;
  label: string;
  icon: string;
  description: string;
};

type Preflight = {
  ai_enabled: boolean;
  internet: boolean;
  api_accessible: boolean;
  all_pass: boolean;
  details: Record<string, string>;
};

type WardriveData = {
  total_aps: number;
  unique_bssids: number;
  total_clients: number;
  aps_over_time: { ts: string; count: number }[];
  encryption_breakdown: Record<string, number>;
  channel_distribution: Record<string, number>;
  signal_distribution: { range: string; count: number }[];
  top_ssids: { ssid: string; count: number }[];
  top_clients: { mac: string; packets: number }[];
};

type TimelineData = {
  events: {
    ts: string;
    kind: string;
    claim: string;
    verdict: string;
    reason: string;
    file: string;
  }[];
};

type LootInvData = {
  total_files: number;
  total_size_bytes: number;
  by_type: Record<string, number>;
  by_type_size: Record<string, number>;
};

type GpsData = {
  trackpoint_count: number;
  coordinates: [number, number][];
  bounds: { min_lat: number; max_lat: number; min_lon: number; max_lon: number } | null;
  distance_m: number;
  avg_speed_mps: number;
  max_speed_mps: number;
  speed_profile: { ts: string; speed: number }[];
};

type ReportData = WardriveData & TimelineData & LootInvData & GpsData & { window?: { start: string; end: string } };

/* ---------- helpers ---------- */

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

/* ---------- chart components (pure CSS/SVG) ---------- */

function BarChart({ data, color }: { data: { label: string; value: number }[]; color: string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-1.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2 text-xs">
          <span className="w-28 text-txt-dim truncate text-right">{d.label}</span>
          <div className="flex-1 h-5 bg-bg-base/40 rounded overflow-hidden border border-border-dim/30">
            <div
              className="h-full rounded transition-all duration-500"
              style={{ width: `${(d.value / max) * 100}%`, background: color }}
            />
          </div>
          <span className="w-12 text-txt-main font-mono text-right">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function LineChart({ data }: { data: { ts: string; count: number }[] }) {
  if (data.length < 2) return <div className="text-txt-dim text-xs py-4 text-center">Not enough data points for chart</div>;
  const w = 600;
  const h = 160;
  const pad = 28;
  const max = Math.max(...data.map((d) => d.count), 1);
  const stepX = (w - pad * 2) / (data.length - 1);
  const pts = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (d.count / max) * (h - pad * 2);
    return { x, y, count: d.count, ts: d.ts };
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${path} L ${pts[pts.length - 1].x.toFixed(1)} ${h - pad} L ${pts[0].x.toFixed(1)} ${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <path d={area} fill="#9B8CF0" opacity={0.15} />
      <path d={path} fill="none" stroke="#9B8CF0" strokeWidth={2} />
      {pts.map((p, i) =>
        i % Math.ceil(pts.length / 8) === 0 ? (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={2.5} fill="#9B8CF0" />
            <text x={p.x} y={h - pad + 12} fill="#888" fontSize={8} textAnchor="middle">{p.ts}</text>
          </g>
        ) : null,
      )}
      <text x={4} y={pad} fill="#888" fontSize={8}>{max}</text>
      <text x={4} y={h - pad} fill="#888" fontSize={8}>0</text>
    </svg>
  );
}

/* ---------- report renderers ---------- */

function WardriveReport({ d }: { d: WardriveData }) {
  const enc = Object.entries(d.encryption_breakdown).map(([label, value]) => ({ label, value }));
  const chan = Object.entries(d.channel_distribution).map(([label, value]) => ({ label: `Ch ${label}`, value }));
  const ssids = d.top_ssids.slice(0, 10).map((s) => ({ label: s.ssid || "<hidden>", value: s.count }));
  const sig = d.signal_distribution.map((s) => ({ label: s.range, value: s.count }));
  const encColor: Record<string, string> = {
    WPA3: "#5AF78E", "WPA3 WPA2": "#5AC8D8", WPA2: "#9B8CF0", Open: "#FFB454", WEP: "#E0556B",
  };
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <Tile title="Total APs"><span className="text-2xl font-bold text-txt-hi">{d.total_aps}</span></Tile>
        <Tile title="Unique BSSIDs"><span className="text-2xl font-bold text-txt-hi">{d.unique_bssids}</span></Tile>
        <Tile title="Clients Seen"><span className="text-2xl font-bold text-txt-hi">{d.total_clients}</span></Tile>
      </div>

      <div>
        <h4 className="text-xs font-bold text-txt-dim uppercase mb-2">APs Over Time</h4>
        <LineChart data={d.aps_over_time} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs font-bold text-txt-dim uppercase mb-2">Encryption Breakdown</h4>
          <div className="space-y-1.5">
            {enc.map((e) => {
              const max = Math.max(...enc.map((x) => x.value), 1);
              return (
                <div key={e.label} className="flex items-center gap-2 text-xs">
                  <span className="w-24 text-txt-dim truncate text-right">{e.label}</span>
                  <div className="flex-1 h-5 bg-bg-base/40 rounded overflow-hidden border border-border-dim/30">
                    <div className="h-full rounded" style={{ width: `${(e.value / max) * 100}%`, background: encColor[e.label] || "#888" }} />
                  </div>
                  <span className="w-8 text-txt-main font-mono text-right">{e.value}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <h4 className="text-xs font-bold text-txt-dim uppercase mb-2">Channel Distribution</h4>
          <BarChart data={chan} color="#5AC8D8" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs font-bold text-txt-dim uppercase mb-2">Signal Strength (dBm)</h4>
          <BarChart data={sig} color="#FFB454" />
        </div>
        <div>
          <h4 className="text-xs font-bold text-txt-dim uppercase mb-2">Top SSIDs</h4>
          <BarChart data={ssids} color="#5AF78E" />
        </div>
      </div>
    </div>
  );
}

function TimelineReport({ d }: { d: TimelineData }) {
  const colors: Record<string, string> = {
    "engagement.started": "text-mint",
    "engagement.ended": "text-txt-dim",
    "scope.violation": "text-pink-alert",
  };
  const dotColors: Record<string, string> = {
    "engagement.started": "bg-mint",
    "engagement.ended": "bg-txt-dim",
    "scope.violation": "bg-pink-alert",
  };
  return (
    <div className="border border-border-dim rounded">
      {d.events.length === 0 && <div className="text-txt-dim text-sm p-4 text-center">No events in window</div>}
      {d.events.map((e, i) => (
        <div key={i} className={`flex items-start gap-3 px-3 py-2 text-xs ${i % 2 === 0 ? "bg-bg-panel/50" : "bg-bg-base/50"}`}>
          <span className={`mt-0.5 inline-block w-2 h-2 rounded-full shrink-0 ${dotColors[e.kind] || "bg-txt-dim"}`} />
          <span className="text-txt-dim whitespace-nowrap font-mono">{e.ts}</span>
          <span className={`font-bold ${colors[e.kind] || "text-txt-main"}`}>{e.kind}</span>
          <span className="text-txt-dim flex-1 truncate">{e.reason}</span>
          {e.verdict === "verified" && <span className="text-mint/60">✓</span>}
        </div>
      ))}
    </div>
  );
}

function LootInvReport({ d }: { d: LootInvData }) {
  const bars = Object.entries(d.by_type).map(([type, count]) => ({ label: type, value: count }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Tile title="Artifacts"><span className="text-2xl font-bold text-txt-hi">{d.total_files}</span></Tile>
        <Tile title="Total Size"><span className="text-2xl font-bold text-txt-hi">{fmtSize(d.total_size_bytes)}</span></Tile>
      </div>
      <BarChart data={bars} color="#9B8CF0" />
    </div>
  );
}

function GpsReport({ d }: { d: GpsData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile title="Track Points"><span className="text-2xl font-bold text-txt-hi">{d.trackpoint_count}</span></Tile>
        <Tile title="Distance"><span className="text-2xl font-bold text-txt-hi">{(d.distance_m / 1000).toFixed(2)} km</span></Tile>
        <Tile title="Bounds">
          {d.bounds ? (
            <span className="text-xs font-mono text-txt-hi">
              {d.bounds.min_lat.toFixed(3)},{d.bounds.min_lon.toFixed(3)} → {d.bounds.max_lat.toFixed(3)},{d.bounds.max_lon.toFixed(3)}
            </span>
          ) : <span className="text-txt-dim">N/A</span>}
        </Tile>
      </div>
      {d.coordinates.length > 1 && d.bounds && (
        <MiniMap coords={d.coordinates} bounds={d.bounds} />
      )}
    </div>
  );
}

function MiniMap({ coords, bounds }: { coords: [number, number][]; bounds: NonNullable<GpsData["bounds"]> }) {
  const w = 600, h = 200, pad = 10;
  const latRange = bounds.max_lat - bounds.min_lat || 0.001;
  const lonRange = bounds.max_lon - bounds.min_lon || 0.001;
  const scale = Math.min((w - pad * 2) / lonRange, (h - pad * 2) / latRange);
  const ox = pad + (w - pad * 2 - lonRange * scale) / 2;
  const oy = pad + (h - pad * 2 - latRange * scale) / 2;
  const project = (lat: number, lon: number) => ({
    x: ox + (lon - bounds.min_lon) * scale,
    y: oy + (bounds.max_lat - lat) * scale,
  });
  const path = coords.map(([lat, lon], i) => {
    const { x, y } = project(lat, lon);
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div>
      <h4 className="text-xs font-bold text-txt-dim uppercase mb-2">Track Map</h4>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full border border-border-dim rounded bg-bg-base/60">
        <path d={path} fill="none" stroke="#5AC8D8" strokeWidth={1.5} opacity={0.7} />
        {(() => { const s = project(coords[0][0], coords[0][1]); return <circle cx={s.x} cy={s.y} r={4} fill="#5AF78E" />; })()}
        {(() => { const e = project(coords[coords.length - 1][0], coords[coords.length - 1][1]); return <circle cx={e.x} cy={e.y} r={4} fill="#E0556B" />; })()}
      </svg>
      <div className="flex gap-4 text-xs text-txt-dim mt-1">
        <span><span className="inline-block w-2 h-2 rounded-full bg-mint mr-1" />Start</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-pink-alert mr-1" />End</span>
      </div>
    </div>
  );
}

/* ---------- main page ---------- */

export function Reports() {
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [selectedEng, setSelectedEng] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [report, setReport] = useState<{ template: string; data: ReportData } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  useEffect(() => {
    apiGet<{ engagements: Engagement[] }>("/api/ops/engagements")
      .then((d) => {
        setEngagements(d.engagements || []);
        const active = d.engagements?.find((e) => e.status === "on" || e.status === "active");
        if (active) setSelectedEng(active.id);
      })
      .catch(() => {});
    apiGet<{ templates: Template[] }>("/api/reports/templates")
      .then((d) => setTemplates(d.templates || []))
      .catch(() => {});
  }, []);

  const generate = useCallback(async (templateId: string) => {
    setBusy(templateId);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      if (selectedEng) body.engagement_id = selectedEng;
      const r = await apiPost<{ report_id: string; template: string; data: ReportData }>(
        `/api/reports/generate/${templateId}`,
        body,
      );
      setReport({ template: r.template, data: r.data });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }, [selectedEng]);

  const runPreflight = useCallback(async () => {
    setBusy("preflight");
    try {
      const r = await apiPost<Preflight>("/api/reports/preflight");
      setPreflight(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }, []);

  const exportJSON = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${report.template}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedEngagement = engagements.find((e) => e.id === selectedEng);

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <ModuleHeader title="Reports" code="reports" state="READY" icon="📊" />

      {error && (
        <div className="mb-4 p-2 rounded border border-pink-alert/40 bg-pink-alert/10 text-pink-alert text-sm">
          {error}
        </div>
      )}

      {/* Engagement selector */}
      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <select
          value={selectedEng}
          onChange={(e) => setSelectedEng(e.target.value)}
          className="bg-bg-panel border border-border-dim rounded px-2 py-1 text-sm text-txt-main"
        >
          <option value="">All Data (no filter)</option>
          {engagements.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} — {e.status} ({fmtTime(e.started_at)})
            </option>
          ))}
        </select>
        {selectedEngagement && (
          <span className="text-xs text-txt-dim">
            Window: {fmtTime(selectedEngagement.started_at)} → {fmtTime(selectedEngagement.ended_at)}
          </span>
        )}
      </div>

      {/* Template cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => generate(t.id)}
            disabled={!!busy}
            className={`p-3 rounded border text-left transition-all ${
              busy === t.id
                ? "border-violet-base bg-violet-base/10 animate-pulse"
                : "border-border-dim hover:border-violet-base/60 hover:bg-bg-panel"
            } ${report?.template === t.id ? "border-violet-base bg-violet-base/5" : "bg-bg-panel/50"}`}
          >
            <div className="text-2xl mb-1">{t.icon}</div>
            <div className="text-sm font-bold text-txt-main">{t.label}</div>
            <div className="text-xs text-txt-dim mt-1">{t.description}</div>
          </button>
        ))}
        {templates.length === 0 && (
          <div className="col-span-4 text-center text-txt-dim py-4 text-sm">
            Loading templates...
          </div>
        )}
      </div>

      {/* Report render area */}
      {report && (
        <div className="border border-border-dim rounded p-4 bg-bg-base/30">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-bold text-txt-hi uppercase tracking-wide">
              {templates.find((t) => t.id === report.template)?.icon} {templates.find((t) => t.id === report.template)?.label}
            </h3>
            <button
              onClick={exportJSON}
              className="px-3 py-1 rounded bg-cyan-signal/20 border border-cyan-signal/40 text-cyan-signal text-xs hover:bg-cyan-signal/30"
            >
              Export JSON
            </button>
          </div>

          {report.template === "wardrive_summary" && <WardriveReport d={report.data as WardriveData} />}
          {report.template === "engagement_timeline" && <TimelineReport d={report.data as TimelineData} />}
          {report.template === "loot_inventory" && <LootInvReport d={report.data as LootInvData} />}
          {report.template === "gps_movement" && <GpsReport d={report.data as GpsData} />}
        </div>
      )}

      {/* Preflight checks */}
      <div className="mt-6 border border-border-dim rounded p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-txt-hi uppercase tracking-wide">AI Preflight</h3>
          <button
            onClick={runPreflight}
            disabled={!!busy}
            className="px-3 py-1 rounded bg-amber-base/20 border border-amber-base/40 text-amber-base text-xs hover:bg-amber-base/30"
          >
            {busy === "preflight" ? "Checking..." : "Check AI Readiness"}
          </button>
        </div>
        {preflight && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "AI Enabled", ok: preflight.ai_enabled },
              { label: "Internet", ok: preflight.internet },
              { label: "API Access", ok: preflight.api_accessible },
            ].map((c) => (
              <div
                key={c.label}
                className={`p-2 rounded border text-center text-sm ${
                  c.ok
                    ? "border-mint/40 bg-mint/10 text-mint"
                    : "border-pink-alert/40 bg-pink-alert/10 text-pink-alert"
                }`}
              >
                {c.ok ? "✓" : "✕"} {c.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {!report && !busy && (
        <div className="text-center text-txt-dim py-8 text-sm">
          Select an engagement and click a report template to generate.
        </div>
      )}
    </div>
  );
}
