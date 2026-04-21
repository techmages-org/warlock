import { useEffect, useState } from "react";
import { apiGet, apiPost, type MeshNode } from "../lib/api";
import { ModuleHeader, SignalBars, StatusLED, Tile } from "../components/hud";

function formatRelTime(epochSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - epochSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function nodeFreshness(lastHeard: number | undefined): "mint" | "amber" | "dim" {
  if (lastHeard == null) return "dim";
  const diff = Date.now() / 1000 - lastHeard;
  if (diff < 600) return "mint";
  if (diff < 3600) return "amber";
  return "dim";
}

export function Mesh() {
  const [nodes, setNodes] = useState<MeshNode[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await apiGet<MeshNode[]>("/api/mesh/nodes");
        if (alive) { setNodes(r); setErr(null); }
      } catch (e: unknown) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setSendErr(null);
    try {
      await apiPost("/api/mesh/send", { text, channel: 0 });
      setText("");
    } catch (e: unknown) {
      setSendErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const freshCount = nodes.filter((n) => nodeFreshness(n.last_heard) === "mint").length;

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="01 MESH-TAC"
        title="Mesh Tactical Net"
        state={err ? "LINK ERROR" : `${nodes.length} KNOWN / ${freshCount} FRESH`}
        icon="⌬"
        right={<span className="hud-label text-txt-dim">meshtasticd TCP :4403</span>}
      />

      <Tile
        title="CHAN 0 TRANSMIT"
        led={sending ? "amber" : "violet"}
        headerRight={<span className="hud-label text-txt-dim">BROADCAST</span>}
      >
        <form onSubmit={send} className="flex gap-2">
          <input
            className="hud-input flex-1"
            placeholder="enter channel 0 message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="mesh message"
          />
          <button className="hud-btn" type="submit" disabled={sending || !text.trim()}>
            {sending ? "…" : "TRANSMIT"}
          </button>
        </form>
        {sendErr && <div className="mt-2 text-pink-alert">send failed: {sendErr}</div>}
      </Tile>

      <Tile
        title="NODE TABLE"
        led={err ? "pink" : nodes.length > 0 ? "mint" : "amber"}
        padded={false}
        headerRight={
          <span className="hud-label text-txt-dim tabular-nums">
            {nodes.length} node{nodes.length === 1 ? "" : "s"}
          </span>
        }
      >
        {err ? (
          <div className="px-4 py-3 text-pink-alert">mesh error: {err}</div>
        ) : nodes.length === 0 ? (
          <div className="px-4 py-3 text-txt-dim">no nodes known yet — waiting on first beacon…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line-dim">
                  <th className="px-3 py-2 text-left hud-label">Node</th>
                  <th className="px-3 py-2 text-left hud-label">SNR</th>
                  <th className="px-3 py-2 text-right hud-label">dB</th>
                  <th className="px-3 py-2 text-right hud-label">Hops</th>
                  <th className="px-3 py-2 text-right hud-label">Batt</th>
                  <th className="px-3 py-2 text-right hud-label">Last heard</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => {
                  const longN =
                    n.long_name && n.long_name !== "Meshtastic Node"
                      ? n.long_name
                      : n.short_name ?? String(n.id).slice(0, 12);
                  const shortN = n.short_name ?? "";
                  const rel = n.last_heard != null ? formatRelTime(n.last_heard) : "—";
                  const fresh = nodeFreshness(n.last_heard);
                  // Meshtastic SNR typically -20 to +15 dB; map onto 0..15 bar scale.
                  const snr = n.snr ?? 0;
                  const snrBarValue = Math.max(0, Math.min(15, snr + 20 - 5));
                  const snrColor: "mint" | "cyan" | "amber" | "pink" =
                    snr >= 5 ? "mint" : snr >= 0 ? "cyan" : snr >= -10 ? "amber" : "pink";
                  return (
                    <tr key={n.id} className="border-b border-line-dim/50 hover:bg-bg-elev/40">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <StatusLED color={fresh} size={6} label={`${longN} freshness`} />
                          <span className="font-semibold text-txt-hi">{longN}</span>
                        </div>
                        <div className="ml-5 text-[0.6875rem] text-txt-dim">
                          {shortN && <span className="text-violet-bright">[{shortN}] </span>}
                          <span className="tabular-nums">{String(n.id)}</span>
                          {n.hw && <span className="ml-2 text-txt-dim">· {n.hw}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <SignalBars value={snrBarValue} min={0} max={15} bars={5} color={snrColor} label={`${snr} dB`} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {n.snr != null ? (
                          <span className="text-cyan-signal">{n.snr.toFixed(2)}</span>
                        ) : (
                          <span className="text-txt-dim">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-txt-body">
                        {n.hops_away != null ? n.hops_away : <span className="text-txt-dim">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {n.battery_pct != null ? (
                          <span className={n.battery_pct < 25 ? "text-pink-alert" : "text-amber-base"}>
                            {n.battery_pct}%
                          </span>
                        ) : (
                          <span className="text-txt-dim">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-txt-dim">{rel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Tile>
    </div>
  );
}
