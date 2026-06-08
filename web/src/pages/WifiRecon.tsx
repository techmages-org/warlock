import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, SignalBars, StatusLED, Tile } from "../components/hud";

type AP = {
  bssid: string;
  essid: string;
  channel: number;
  encryption: string;
  cipher: string;
  auth: string;
  signal: number;
  beacons: number;
  ivs: number;
  first_seen: string;
  last_seen: string;
  wps: boolean;
  // wardriving geo (additive — null until a BSSID is GPS-stamped at first sight)
  lat?: number | null;
  lon?: number | null;
  alt?: number | null;
  geo_fixed?: boolean;
};

type Client = {
  station: string;
  associated: string | null;
  probes: string[];
  power: number;
  packets: number;
  first_seen: string;
  last_seen: string;
};

type Handshake = {
  filename: string;
  path: string;
  size_bytes: number;
  mtime: string;
  eapol: boolean;
  networks: string[];
};

type Status = {
  ok: boolean;
  running: boolean;
  iface: string | null;
  channels: string | null;
  aps_seen: number;
  clients_seen: number;
  uptime_s: number | null;
  prefix: string | null;
  started_at: string | null;
};

type Tab = "aps" | "clients" | "handshakes" | "control";

const TABS: { id: Tab; label: string }[] = [
  { id: "aps", label: "APs" },
  { id: "clients", label: "Clients" },
  { id: "handshakes", label: "Handshakes" },
  { id: "control", label: "Control" },
];

export function WifiRecon() {
  const [tab, setTab] = useState<Tab>("aps");
  const [status, setStatus] = useState<Status | null>(null);
  const [aps, setAps] = useState<AP[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [hands, setHands] = useState<Handshake[]>([]);
  const [note, setNote] = useState<string>("");
  const [channels, setChannels] = useState<string>("all");
  const [withCoords, setWithCoords] = useState<number>(0);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiGet<Status>("/api/wifi_recon/status"));
    } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (tab !== "aps") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ aps: AP[]; with_coords?: number }>("/api/wifi_recon/aps");
        if (alive) {
          setAps(d.aps || []);
          setWithCoords(d.with_coords ?? 0);
        }
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "clients") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ clients: Client[] }>("/api/wifi_recon/clients");
        if (alive) setClients(d.clients || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [tab]);

  useEffect(() => {
    if (tab !== "handshakes") return;
    let alive = true;
    apiGet<{ handshakes: Handshake[] }>("/api/wifi_recon/handshakes")
      .then((d) => { if (alive) setHands(d.handshakes || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [tab]);

  const running = !!status?.running;
  const stateLabel = status == null ? "ACQUIRING" : running ? "SCANNING" : "IDLE";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="05 WIFI-PAS"
        title="WiFi Recon"
        state={stateLabel}
        icon="☰"
        right={
          <span className="hud-label text-txt-dim">
            {status?.iface ?? "—"} · {status?.aps_seen ?? 0} AP / {status?.clients_seen ?? 0} STA
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
          <BigValue value={running ? "SCAN" : "IDLE"} color={running ? "mint" : "amber"} size="md" />
        </Tile>
        <Tile title="IFACE">
          <BigValue value={status?.iface ?? "—"} color="violet" size="md" />
        </Tile>
        <Tile title="UPTIME">
          <BigValue value={status?.uptime_s != null ? `${status.uptime_s}s` : "—"} color="cyan" />
        </Tile>
        <Tile title="INVENTORY">
          <div className="text-txt-body tabular-nums">
            <span className="text-amber-base">{status?.aps_seen ?? 0}</span> AP
            <span className="mx-1 text-txt-dim">·</span>
            <span className="text-cyan-signal">{status?.clients_seen ?? 0}</span> STA
          </div>
        </Tile>
      </div>

      {tab === "aps" && (
        <APsTab
          aps={aps}
          withCoords={withCoords}
          busy={busy}
          onClear={async () => {
            setBusy("clear");
            try {
              const d = await apiPost<{ cleared_stamps?: number; note?: string }>("/api/wifi_recon/clear");
              setNote(
                d.note
                  ? `clear: ${d.note}`
                  : `cleared AP list — dropped ${d.cleared_stamps ?? 0} geo-stamp(s); still-present APs re-appear as re-seen`,
              );
              setAps([]);
              setWithCoords(0);
            } catch (e) { setNote(`clear failed: ${e}`); }
            finally { setBusy(null); }
          }}
          onExport={async () => {
            setBusy("export");
            try {
              const d = await apiPost<{ count: number; with_coords: number; csv: string; kml: string }>(
                "/api/wifi_recon/export",
              );
              setNote(`exported ${d.count} APs · ${d.with_coords} geo → ${d.csv} · ${d.kml}`);
            } catch (e) { setNote(`export failed: ${e}`); }
            finally { setBusy(null); }
          }}
        />
      )}
      {tab === "clients" && <ClientsTab clients={clients} />}
      {tab === "handshakes" && <HandshakesTab rows={hands} />}
      {tab === "control" && (
        <ControlTab
          running={running}
          channels={channels}
          setChannels={setChannels}
          onStart={async () => {
            try {
              const d = await apiPost<Record<string, unknown>>("/api/wifi_recon/start", { channels });
              setNote(`started — ${(d.state as Record<string, unknown> | undefined)?.prefix ?? ""}`);
            } catch (e) { setNote(`start failed: ${e}`); }
            refresh();
          }}
          onStop={async () => {
            try {
              await apiPost("/api/wifi_recon/stop");
              setNote("stopped — helper returned mon0 to managed");
            } catch (e) { setNote(`stop failed: ${e}`); }
            refresh();
          }}
        />
      )}
    </div>
  );
}

function encColor(enc: string): "mint" | "amber" | "pink" | "violet" {
  if (!enc || enc === "OPN") return "pink";
  if (enc.includes("WEP")) return "pink";
  if (enc.includes("WPA3")) return "mint";
  if (enc.includes("WPA2")) return "violet";
  return "amber";
}

function APsTab({
  aps,
  withCoords,
  busy,
  onClear,
  onExport,
}: {
  aps: AP[];
  withCoords: number;
  busy: string | null;
  onClear: () => void;
  onExport: () => void;
}) {
  return (
    <Tile
      title="ACCESS POINTS"
      padded={false}
      led={aps.length > 0 ? "mint" : "amber"}
      headerRight={
        <div className="flex items-center gap-2">
          <span className="hud-label text-txt-dim">
            <span className="text-amber-base tabular-nums">{aps.length}</span> APs
            <span className="mx-1">·</span>
            <span className="text-mint-safe tabular-nums">{withCoords}</span> geo
          </span>
          <button
            className="hud-btn px-2 py-0.5 text-[0.72rem] border-cyan-signal text-cyan-signal disabled:opacity-40"
            onClick={onExport}
            disabled={busy === "export" || aps.length === 0}
            title="write CSV + KML (GPS-located APs) to ~/warlock/captures/wifi/exports/"
          >
            {busy === "export" ? "⟳ exporting…" : "⤓ Export"}
          </button>
          <button
            className="hud-btn px-2 py-0.5 text-[0.72rem] border-pink-alert text-pink-alert disabled:opacity-40"
            onClick={onClear}
            disabled={busy === "clear" || aps.length === 0}
            title="reset the AP list (sets a clear baseline + drops geo-stamps; scan keeps running)"
          >
            {busy === "clear" ? "⟳ clearing…" : "✕ Clear list"}
          </button>
        </div>
      }
    >
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">BSSID</th>
              <th className="hud-label px-3 py-2 text-left">ESSID</th>
              <th className="hud-label px-3 py-2 text-left">CH</th>
              <th className="hud-label px-3 py-2 text-left">ENC</th>
              <th className="hud-label px-3 py-2 text-left">SIG</th>
              <th className="hud-label px-3 py-2 text-left">GPS</th>
              <th className="hud-label px-3 py-2 text-left">Beacons</th>
            </tr>
          </thead>
          <tbody>
            {aps.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-4 text-txt-dim">no APs yet — start a scan</td></tr>
            )}
            {aps.slice(0, 200).map((a) => (
              <tr
                key={a.bssid}
                className={"border-b border-line-dim/40 " + (a.wps ? "bg-amber-base/5" : "")}
              >
                <td className="px-3 py-1 text-txt-body tabular-nums">{a.bssid}</td>
                <td className="px-3 py-1 text-violet-bright">{a.essid || <span className="text-txt-dim">—</span>}</td>
                <td className="px-3 py-1 tabular-nums text-txt-body">{a.channel || "?"}</td>
                <td className={`px-3 py-1 text-${encColor(a.encryption)}-${encColor(a.encryption) === "mint" ? "safe" : encColor(a.encryption) === "amber" ? "base" : encColor(a.encryption) === "pink" ? "alert" : "bright"}`}>
                  {a.encryption || "?"}
                  {a.wps && <span className="ml-1 text-amber-base">WPS</span>}
                </td>
                <td className="px-3 py-1">
                  <span className="inline-flex items-center gap-2">
                    <SignalBars value={a.signal} min={-95} max={-30} color="cyan" />
                    <span className="text-cyan-signal tabular-nums">{a.signal}</span>
                  </span>
                </td>
                <td className="px-3 py-1 tabular-nums">
                  {a.lat != null && a.lon != null ? (
                    <span
                      className={a.geo_fixed ? "text-mint-safe" : "text-txt-body"}
                      title={a.geo_fixed ? "GPS fix at first sighting" : "stamped without a live fix"}
                    >
                      {a.lat.toFixed(4)},{a.lon.toFixed(4)}
                    </span>
                  ) : (
                    <span className="text-txt-dim">—</span>
                  )}
                </td>
                <td className="px-3 py-1 tabular-nums text-txt-dim">{a.beacons}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function ClientsTab({ clients }: { clients: Client[] }) {
  // Group by associated BSSID
  const groups: Record<string, Client[]> = {};
  for (const c of clients) {
    const k = c.associated || "(unassociated)";
    (groups[k] ||= []).push(c);
  }
  return (
    <Tile title="STATIONS" padded={false} led={clients.length > 0 ? "cyan" : "amber"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">STA</th>
              <th className="hud-label px-3 py-2 text-left">Assoc AP</th>
              <th className="hud-label px-3 py-2 text-left">PWR</th>
              <th className="hud-label px-3 py-2 text-left">PKT</th>
              <th className="hud-label px-3 py-2 text-left">Probes</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-txt-dim">no clients yet</td></tr>
            )}
            {Object.entries(groups).map(([bssid, list]) => (
              <>
                <tr key={`hdr-${bssid}`} className="border-t border-line-mid">
                  <td colSpan={5} className="px-3 py-1 hud-label text-violet-bright">{bssid}</td>
                </tr>
                {list.map((c) => (
                  <tr key={c.station} className="border-b border-line-dim/40">
                    <td className="px-3 py-1 tabular-nums text-txt-body">{c.station}</td>
                    <td className="px-3 py-1 text-txt-dim tabular-nums">{c.associated ?? "—"}</td>
                    <td className="px-3 py-1 tabular-nums text-cyan-signal">{c.power}</td>
                    <td className="px-3 py-1 tabular-nums text-txt-body">{c.packets}</td>
                    <td className="px-3 py-1 text-txt-dim">{c.probes.join(", ") || "—"}</td>
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

function HandshakesTab({ rows }: { rows: Handshake[] }) {
  return (
    <Tile title="EAPOL CAPTURES" padded={false} led={rows.some(r => r.eapol) ? "mint" : "amber"}>
      <div className="overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line-dim">
              <th className="hud-label px-3 py-2 text-left">File</th>
              <th className="hud-label px-3 py-2 text-left">Size</th>
              <th className="hud-label px-3 py-2 text-left">EAPOL</th>
              <th className="hud-label px-3 py-2 text-left">mtime</th>
              <th className="hud-label px-3 py-2 text-left">Networks</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-txt-dim">
                no capture files yet — handshakes are written to ~/warlock/captures/wifi/ and ~/warlock/handshakes/
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.path} className="border-b border-line-dim/40">
                <td className="px-3 py-1 text-txt-body">{r.filename}</td>
                <td className="px-3 py-1 tabular-nums text-txt-dim">
                  {(r.size_bytes / 1024).toFixed(1)} KB
                </td>
                <td className={"px-3 py-1 " + (r.eapol ? "text-mint-safe" : "text-txt-dim")}>
                  {r.eapol ? "✓" : "·"}
                </td>
                <td className="px-3 py-1 text-txt-dim tabular-nums">{r.mtime.slice(0, 19)}</td>
                <td className="px-3 py-1 text-violet-bright text-[0.75rem]">
                  {r.networks.slice(0, 2).join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    { v: "all", l: "All bands" },
    { v: "2.4", l: "2.4 GHz" },
    { v: "5", l: "5 GHz" },
    { v: "1,6,11", l: "2.4 GHz — 1/6/11" },
  ];
  return (
    <Tile title="CAPTURE CONTROL" led={running ? "mint" : "violet"}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <StatusLED color={running ? "mint" : "dim"} />
          <span className="text-txt-body">
            {running ? "airodump-ng running on mon0" : "idle — ready to start"}
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
            className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
            onClick={onStart}
            disabled={running}
          >
            ▶ START SCAN
          </button>
          <button
            className="hud-btn border-pink-alert text-pink-alert disabled:opacity-40"
            onClick={onStop}
            disabled={!running}
          >
            ■ STOP SCAN
          </button>
        </div>

        <div className="text-txt-dim text-[0.75rem]">
          Start puts the MT7921 USB dongle into monitor mode via{" "}
          <code className="text-violet-bright">wlan-mt7921 monitor</code>, then launches{" "}
          <code className="text-violet-bright">airodump-ng</code> writing CSV + pcap into{" "}
          <code className="text-violet-bright">~/warlock/captures/wifi/</code>. Stop returns the
          iface to managed mode.
        </div>
      </div>
    </Tile>
  );
}
