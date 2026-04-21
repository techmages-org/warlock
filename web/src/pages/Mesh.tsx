import { useEffect, useState } from "react";
import { apiGet, apiPost, type MeshNode } from "../lib/api";


function formatRelTime(epochSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - epochSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function Mesh() {
  const [nodes, setNodes] = useState<MeshNode[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await apiGet<MeshNode[]>("/api/mesh/nodes");
        if (alive) {
          setNodes(r);
          setErr(null);
        }
      } catch (e: any) {
        if (alive) setErr(String(e));
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await apiPost("/api/mesh/send", { text, channel: 0 });
      setText("");
    } catch (e: any) {
      alert(`send failed: ${e}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <h1 className="text-lg font-bold mb-4">Mesh</h1>

      <form onSubmit={send} className="wl-card mb-4 flex gap-2">
        <input
          className="flex-1 bg-warlock-bg border border-warlock-border rounded px-2 py-1 text-sm"
          placeholder="Channel 0 message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="wl-btn" type="submit" disabled={sending || !text.trim()}>
          {sending ? "…" : "Send"}
        </button>
      </form>

      <div className="wl-card overflow-x-auto">
        {err ? (
          <div className="text-warlock-danger">mesh error: {err}</div>
        ) : nodes.length === 0 ? (
          <div className="text-warlock-muted">no nodes known yet</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-warlock-muted">
              <tr>
                <th className="text-left p-1">Node</th>
                <th className="text-right p-1">SNR</th>
                <th className="text-right p-1">Hops</th>
                <th className="text-right p-1">Batt</th>
                <th className="text-right p-1">Last heard</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const longN = n.long_name && n.long_name !== "Meshtastic Node" ? n.long_name : (n.short_name ?? String(n.id).slice(0, 12));
                const shortN = n.short_name ?? "";
                const relHeard = n.last_heard != null ? formatRelTime(n.last_heard) : "";
                return (
                  <tr key={n.id} className="border-t border-warlock-border">
                    <td className="p-1">
                      <div className="font-semibold text-warlock-text">{longN}</div>
                      <div className="text-xs text-warlock-muted">
                        {shortN && <span className="text-warlock-accent">[{shortN}]</span>}
                        <span className="ml-2">{String(n.id)}</span>
                      </div>
                    </td>
                    <td className="p-1 text-right">{n.snr != null ? `${n.snr} dB` : "—"}</td>
                    <td className="p-1 text-right">{n.hops_away != null ? n.hops_away : "—"}</td>
                    <td className="p-1 text-right">{n.battery_pct != null ? `${n.battery_pct}%` : "—"}</td>
                    <td className="p-1 text-right text-warlock-muted">{relHeard}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
