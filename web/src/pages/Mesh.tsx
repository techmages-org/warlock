import { useEffect, useState } from "react";
import { apiGet, apiPost, type MeshNode } from "../lib/api";

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
                <th className="text-left p-1">ID</th>
                <th className="text-left p-1">Short</th>
                <th className="text-left p-1">Long</th>
                <th className="text-right p-1">SNR</th>
                <th className="text-right p-1">Hops</th>
                <th className="text-right p-1">Batt</th>
                <th className="text-left p-1">Last heard</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.id} className="border-t border-warlock-border">
                  <td className="p-1 text-warlock-accent">{String(n.id).slice(0, 12)}</td>
                  <td className="p-1">{n.short_name ?? ""}</td>
                  <td className="p-1">{n.long_name ?? ""}</td>
                  <td className="p-1 text-right">{n.snr ?? ""}</td>
                  <td className="p-1 text-right">{n.hops_away ?? ""}</td>
                  <td className="p-1 text-right">{n.battery_pct != null ? `${n.battery_pct}%` : ""}</td>
                  <td className="p-1">{n.last_heard ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
