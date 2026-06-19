import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { ModuleHeader, Tile } from "../components/hud";

type Artifact = {
  id: string;
  type: string;
  module: string;
  path: string;
  name: string;
  size_bytes: number;
  created_at: number;
  download_url: string;
};

type LootResponse = {
  ok: boolean;
  artifacts: Artifact[];
  count: number;
  total_size_bytes: number;
  by_type: Record<string, { count: number; size_bytes: number }>;
};

const TYPE_ICONS: Record<string, string> = {
  wifi_pcap: "📶",
  wifi_csv: "📊",
  wifi_geojson: "📍",
  wifi_kml: "🗺️",
  wifi_export_csv: "📤",
  wifi_export_kml: "🗺️",
  wifi_handshake: "🤝",
  cracked_hash: "🔓",
  sdr_iq: "📡",
  gps_track: "🛰️",
  net_pcap: "📦",
  report: "📄",
  aar_record: "🔏",
  walk_test: "🚶",
  wids_log: "🛡️",
};

function fmtSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Loot() {
  const [data, setData] = useState<LootResponse | null>(null);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      setError("");
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (moduleFilter) params.set("module", moduleFilter);
      const q = params.toString();
      const d = await apiGet<LootResponse>(`/api/loot${q ? `?${q}` : ""}`);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [typeFilter, moduleFilter]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search) return data.artifacts;
    const s = search.toLowerCase();
    return data.artifacts.filter(
      (a) => a.name.toLowerCase().includes(s) || a.type.toLowerCase().includes(s),
    );
  }, [data, search]);

  // Group by type
  const grouped = useMemo(() => {
    const g: Record<string, Artifact[]> = {};
    for (const a of filtered) {
      if (!g[a.type]) g[a.type] = [];
      g[a.type].push(a);
    }
    return g;
  }, [filtered]);

  const types = data ? Object.keys(data.by_type).sort() : [];
  const modules = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.artifacts.map((a) => a.module))].sort();
  }, [data]);

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const downloadArchive = async () => {
    if (selected.size === 0) return;
    setBusy("Archiving...");
    try {
      const r = await fetch("/api/loot/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selected] }),
        credentials: "include",
      });
      if (!r.ok) throw new Error("Archive failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "loot.zip";
      a.click();
      URL.revokeObjectURL(url);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const deleteArtifact = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    try {
      const r = await fetch(`/api/loot/${path}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Delete failed");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <ModuleHeader title="Loot" code="loot" state="READY" icon="💰" />

      {error && (
        <div className="mb-4 p-2 rounded border border-pink-alert/40 bg-pink-alert/10 text-pink-alert text-sm">
          {error}
        </div>
      )}

      {/* Summary tiles */}
      {data && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Tile title="Artifacts"><span className="text-2xl font-bold text-txt-hi">{data.count}</span></Tile>
          <Tile title="Total Size"><span className="text-2xl font-bold text-txt-hi">{fmtSize(data.total_size_bytes)}</span></Tile>
          <Tile title="Types"><span className="text-2xl font-bold text-txt-hi">{types.length}</span></Tile>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-bg-panel border border-border-dim rounded px-2 py-1 text-sm text-txt-main"
        >
          <option value="">All Types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {TYPE_ICONS[t] || "📄"} {t} ({data?.by_type[t]?.count || 0})
            </option>
          ))}
        </select>

        <select
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          className="bg-bg-panel border border-border-dim rounded px-2 py-1 text-sm text-txt-main"
        >
          <option value="">All Modules</option>
          {modules.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-bg-panel border border-border-dim rounded px-2 py-1 text-sm text-txt-main flex-1 min-w-[120px]"
        />

        {selected.size > 0 && (
          <button
            onClick={downloadArchive}
            disabled={!!busy}
            className="px-3 py-1 rounded bg-cyan-signal/20 border border-cyan-signal/40 text-cyan-signal text-sm hover:bg-cyan-signal/30"
          >
            {busy || `Download ZIP (${selected.size})`}
          </button>
        )}
      </div>

      {/* Artifact groups */}
      {Object.entries(grouped).map(([type, artifacts]) => (
        <div key={type} className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">{TYPE_ICONS[type] || "📄"}</span>
            <h3 className="text-sm font-bold text-txt-main uppercase tracking-wide">{type}</h3>
            <span className="text-xs text-txt-dim">
              ({artifacts.length}) —{" "}
              {fmtSize(artifacts.reduce((s, a) => s + a.size_bytes, 0))}
            </span>
          </div>

          <div className="border border-border-dim rounded overflow-hidden">
            {artifacts.map((a, i) => (
              <div
                key={a.path}
                className={`flex items-center gap-3 px-3 py-2 text-sm ${
                  i % 2 === 0 ? "bg-bg-panel/50" : "bg-bg-base/50"
                } hover:bg-bg-active/30`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(a.path)}
                  onChange={() => toggleSelect(a.path)}
                  className="accent-cyan-signal"
                />
                <span className="flex-1 truncate text-txt-main" title={a.path}>
                  {a.name}
                </span>
                <span className="text-txt-dim text-xs whitespace-nowrap">
                  {fmtSize(a.size_bytes)}
                </span>
                <span className="text-txt-dim text-xs whitespace-nowrap">
                  {fmtDate(a.created_at)}
                </span>
                <a
                  href={`/api/loot/download/${a.path}`}
                  className="text-cyan-signal hover:text-cyan-signal/80 text-xs px-2"
                >
                  Download
                </a>
                <button
                  onClick={() => deleteArtifact(a.path)}
                  className="text-pink-alert/70 hover:text-pink-alert text-xs px-1"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {!data && !error && (
        <div className="text-center text-txt-dim py-8">Scanning for artifacts...</div>
      )}
      {data && data.count === 0 && (
        <div className="text-center text-txt-dim py-8">No artifacts found. Go collect some loot.</div>
      )}
    </div>
  );
}
