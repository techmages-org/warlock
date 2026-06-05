// ============================================================================
// WIFI RECON (wifi_recon) — passive airodump-ng sweep. Mirrors web WifiRecon.tsx
// against the SAME backend (src/warlock/modules/wifi_recon.py router()):
//   primary poll  GET  /api/wifi_recon/status   → {running, iface, aps_seen, …}
//   GET /api/wifi_recon/aps · /clients · /handshakes   (active view only)
//   POST /api/wifi_recon/start {channels} · /stop
// Single primary usePoll on /status with the dashboard error guard; the active
// sub-view's list polls separately and silently degrades to empty (like web).
//
// GEOMETRY: reads the live terminal via useStdout() and bounds every layout to
// the rows/cols actually available (fallback 24x120 = design target & test
// default). One view at a time; the active list scrolls in a fitted window with
// a "+N more" indicator so it never overflows however many APs/clients appear.
//
// Keys (headless-guarded): Tab or 1–4 switch view (APs/Clients/Handshakes/
//   Control). Lists: ↑/↓ scroll. Control: ←/→ channels · s start · x stop.
// ============================================================================

import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

const CHROME_ROWS = 8;

type AP = { bssid: string; essid: string; channel: number; encryption: string; signal: number; beacons: number; wps: boolean };
type Client = { station: string; associated: string | null; probes: string[]; power: number; packets: number };
type Handshake = { filename: string; path: string; size_bytes: number; eapol: boolean; networks: string[] };

type ReconStatus = {
  ok: boolean;
  running: boolean;
  iface: string | null;
  channels: string | null;
  aps_seen: number;
  clients_seen: number;
  uptime_s: number | null;
};

type View = "aps" | "clients" | "handshakes" | "control";
const VIEWS: { id: View; label: string }[] = [
  { id: "aps", label: "APs" },
  { id: "clients", label: "Clients" },
  { id: "handshakes", label: "Handshakes" },
  { id: "control", label: "Control" },
];

const CHAN = [
  { v: "all", l: "All bands" },
  { v: "2.4", l: "2.4 GHz" },
  { v: "5", l: "5 GHz" },
  { v: "1,6,11", l: "2.4 — 1/6/11" },
];

export function encColor(enc: string): LEDColor {
  if (!enc || enc === "OPN") return "pink";
  if (enc.includes("WEP")) return "pink";
  if (enc.includes("WPA3")) return "mint";
  if (enc.includes("WPA2")) return "violet";
  return "amber";
}
function sigColor(sig: number): LEDColor {
  if (sig >= -60) return "mint";
  if (sig >= -75) return "amber";
  return "pink";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function useViewport() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 24;
  return { cols, rows, body: Math.max(6, rows - CHROME_ROWS) };
}
function windowOf<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number; more: number } {
  if (cap <= 0 || items.length <= cap) return { slice: items, start: 0, more: Math.max(0, items.length - Math.max(0, cap)) };
  const start = clamp(sel - Math.floor(cap / 2), 0, items.length - cap);
  return { slice: items.slice(start, start + cap), start, more: items.length - cap };
}
function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export function Screen() {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { cols, body } = useViewport();
  const { data: s, error } = usePoll<ReconStatus>(
    () => api.get<ReconStatus>("/api/wifi_recon/status"),
    2000,
    [api],
  );

  const [view, setView] = useState<View>("aps");
  const [aps, setAps] = useState<AP[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [hands, setHands] = useState<Handshake[]>([]);
  const [chanIdx, setChanIdx] = useState(0);
  const [listSel, setListSel] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        if (view === "aps") {
          const d = await api.get<{ aps: AP[] }>("/api/wifi_recon/aps");
          if (alive) setAps(d.aps || []);
        } else if (view === "clients") {
          const d = await api.get<{ clients: Client[] }>("/api/wifi_recon/clients");
          if (alive) setClients(d.clients || []);
        } else if (view === "handshakes") {
          const d = await api.get<{ handshakes: Handshake[] }>("/api/wifi_recon/handshakes");
          if (alive) setHands(d.handshakes || []);
        }
      } catch {
        /* silent degrade — primary /status drives the error frame */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, view]);

  const running = !!s?.running;

  const viewRef = useLive(view);
  const chanIdxRef = useLive(chanIdx);
  const runningRef = useLive(running);
  const busyRef = useLive(busy);
  const apsRef = useLive(aps);
  const clientsRef = useLive(clients);
  const handsRef = useLive(hands);

  const start = async () => {
    setBusy(true);
    try {
      const ch = CHAN[chanIdxRef.current].v;
      await api.post("/api/wifi_recon/start", { channels: ch });
      setNote(`scan started — monitor mode, channels ${ch}`);
    } catch (e) {
      setNote(`start failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api.post("/api/wifi_recon/stop");
      setNote("scan stopped — iface returned to managed mode");
    } catch (e) {
      setNote(`stop failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const activeLen = () => {
    const v = viewRef.current;
    return v === "aps" ? apsRef.current.length : v === "clients" ? clientsRef.current.length : v === "handshakes" ? handsRef.current.length : 0;
  };

  useInput(
    (input, key) => {
      if (key.tab) {
        setView((v) => VIEWS[(VIEWS.findIndex((x) => x.id === v) + 1) % VIEWS.length].id);
        setListSel(0);
        return;
      }
      if (input === "1") { setView("aps"); setListSel(0); }
      else if (input === "2") { setView("clients"); setListSel(0); }
      else if (input === "3") { setView("handshakes"); setListSel(0); }
      else if (input === "4") { setView("control"); setListSel(0); }
      else if (viewRef.current === "control") {
        if (key.leftArrow || key.rightArrow) {
          const dir = key.leftArrow ? -1 : 1;
          setChanIdx((i) => (i + dir + CHAN.length) % CHAN.length);
        } else if (input === "s" && !runningRef.current && !busyRef.current) void start();
        else if (input === "x" && runningRef.current && !busyRef.current) void stop();
      } else {
        const n = activeLen();
        if (key.upArrow) setListSel((v) => clamp(v - 1, 0, Math.max(0, n - 1)));
        else if (key.downArrow) setListSel((v) => clamp(v + 1, 0, Math.max(0, n - 1)));
      }
    },
    { isActive: rawOk },
  );

  if (error) {
    return (
      <Box flexDirection="column" width={cols - 1}>
        <ModuleHeader code="05 WIFI-PAS" title="WiFi Recon" state="LINK ERROR" icon="☰" />
        <Tile title="ERROR" led="pink" width={Math.min(cols - 1, 56)}>
          <Text color={COLORS.pink}>wifi_recon error: {error}</Text>
        </Tile>
      </Box>
    );
  }
  if (!s) {
    return (
      <Box flexDirection="column" width={cols - 1}>
        <ModuleHeader code="05 WIFI-PAS" title="WiFi Recon" state="ACQUIRING" icon="☰" />
        <Tile title="BOOT" led="amber" width={Math.min(cols - 1, 28)}>
          <Text color={TEXT.dim}>acquiring recon state…</Text>
        </Tile>
      </Box>
    );
  }

  const stateLabel = running ? "SCANNING" : "IDLE";
  // Rows available for the active list window.
  let fixed = 1 /*header*/ + 1 /*tabs*/ + 1 /*stat*/ + 1 /*footer*/;
  if (note) fixed += 1;
  const listChrome = view === "control" ? 0 : 1 /*colheader*/;
  const tileChrome = 2 /*border*/ + 1 /*title*/ + listChrome;
  const cap = Math.max(1, body - fixed - tileChrome - 1 /*"+N more"*/);

  const sel = clamp(listSel, 0, Math.max(0, activeLen() - 1));

  return (
    <Box flexDirection="column" width={cols - 1}>
      <ModuleHeader
        code="05 WIFI-PAS"
        title="WiFi Recon"
        state={stateLabel}
        icon="☰"
        right={<Text color={TEXT.dim}>{s.iface ?? "—"} · {s.aps_seen}/{s.clients_seen}</Text>}
      />

      {/* View tabs */}
      <Box>
        {VIEWS.map((v) => {
          const on = v.id === view;
          return (
            <Box key={v.id} marginRight={1}>
              <Text bold={on} color={on ? COLORS.violet : TEXT.dim} backgroundColor={on ? "#1e1b2e" : undefined}>
                {" "}{v.label}{" "}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Compact stat strip (replaces the 5-row tile grid) */}
      <Box>
        <StatusLED color={running ? "mint" : "amber"} />
        <Text color={TEXT.body}> {running ? "SCAN" : "IDLE"} </Text>
        <Text color={TEXT.dim}>· iface </Text>
        <Text color={COLORS.violet}>{s.iface ?? "—"}</Text>
        <Text color={TEXT.dim}> · up {s.uptime_s != null ? `${s.uptime_s}s` : "—"} · </Text>
        <Text color={COLORS.amber}>{s.aps_seen}</Text>
        <Text color={TEXT.dim}> AP / </Text>
        <Text color={COLORS.cyan}>{s.clients_seen}</Text>
        <Text color={TEXT.dim}> STA</Text>
      </Box>

      {note ? (
        <Box>
          <Text color={COLORS.amber} wrap="truncate-end">» {note}</Text>
        </Box>
      ) : null}

      {view === "aps" && <APsView aps={aps} cols={cols} sel={sel} cap={cap} />}
      {view === "clients" && <ClientsView clients={clients} cols={cols} sel={sel} cap={cap} />}
      {view === "handshakes" && <HandshakesView rows={hands} cols={cols} sel={sel} cap={cap} />}
      {view === "control" && <ControlView running={running} chanIdx={chanIdx} busy={busy} cols={cols} />}

      <Box>
        <Text color={TEXT.dim} wrap="truncate-end">
          Tab/1–4 view{view === "control" ? " · ←/→ channels · s start · x stop" : " · ↑/↓ scroll"}
        </Text>
      </Box>
    </Box>
  );
}

function MoreLine({ more, pos, total }: { more: number; pos: number; total: number }) {
  if (more <= 0) return null;
  return <Text color={TEXT.dim}>  +{more} more — ↑/↓ to scroll ({pos}/{total})</Text>;
}

function APsView({ aps, cols, sel, cap }: { aps: AP[]; cols: number; sel: number; cap: number }) {
  const win = windowOf(aps, sel, cap);
  return (
    <Tile title={`ACCESS POINTS (${aps.length})`} led={aps.length > 0 ? "mint" : "amber"} width={cols - 1}>
      <Box>
        <Box width={3}><Text color={TEXT.dim}> </Text></Box>
        <Box width={20}><Text color={TEXT.dim}>BSSID</Text></Box>
        <Box width={20}><Text color={TEXT.dim}>ESSID</Text></Box>
        <Box width={5}><Text color={TEXT.dim}>CH</Text></Box>
        <Box width={12}><Text color={TEXT.dim}>ENC</Text></Box>
        <Box width={6}><Text color={TEXT.dim}>SIG</Text></Box>
        <Box><Text color={TEXT.dim}>BCN</Text></Box>
      </Box>
      {aps.length === 0 ? (
        <Text color={TEXT.dim}>no APs yet — start a scan (Control → s)</Text>
      ) : (
        win.slice.map((a) => {
          const on = aps.indexOf(a) === sel;
          return (
            <Box key={a.bssid}>
              <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
              <Box width={20}><Text color={on ? TEXT.hi : TEXT.body}>{a.bssid}</Text></Box>
              <Box width={20}><Text color={a.essid ? COLORS.violet : TEXT.dim} wrap="truncate-end">{a.essid || "— hidden"}</Text></Box>
              <Box width={5}><Text color={TEXT.body}>{a.channel || "?"}</Text></Box>
              <Box width={12}><Text color={COLORS[encColor(a.encryption)]}>{a.encryption || "?"}{a.wps ? " W" : ""}</Text></Box>
              <Box width={6}><Text color={COLORS[sigColor(a.signal)]}>{a.signal}</Text></Box>
              <Box><Text color={TEXT.dim}>{a.beacons}</Text></Box>
            </Box>
          );
        })
      )}
      <MoreLine more={win.more} pos={sel + 1} total={aps.length} />
    </Tile>
  );
}

function ClientsView({ clients, cols, sel, cap }: { clients: Client[]; cols: number; sel: number; cap: number }) {
  const win = windowOf(clients, sel, cap);
  return (
    <Tile title={`STATIONS (${clients.length})`} led={clients.length > 0 ? "cyan" : "amber"} width={cols - 1}>
      <Box>
        <Box width={3}><Text color={TEXT.dim}> </Text></Box>
        <Box width={20}><Text color={TEXT.dim}>STA</Text></Box>
        <Box width={20}><Text color={TEXT.dim}>ASSOC AP</Text></Box>
        <Box width={6}><Text color={TEXT.dim}>PWR</Text></Box>
        <Box width={6}><Text color={TEXT.dim}>PKT</Text></Box>
        <Box><Text color={TEXT.dim}>PROBES</Text></Box>
      </Box>
      {clients.length === 0 ? (
        <Text color={TEXT.dim}>no clients yet</Text>
      ) : (
        win.slice.map((c) => {
          const on = clients.indexOf(c) === sel;
          return (
            <Box key={c.station}>
              <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
              <Box width={20}><Text color={on ? TEXT.hi : TEXT.body}>{c.station}</Text></Box>
              <Box width={20}><Text color={TEXT.dim}>{c.associated ?? "—"}</Text></Box>
              <Box width={6}><Text color={COLORS.cyan}>{c.power}</Text></Box>
              <Box width={6}><Text color={TEXT.body}>{c.packets}</Text></Box>
              <Box><Text color={TEXT.dim} wrap="truncate-end">{c.probes.join(", ") || "—"}</Text></Box>
            </Box>
          );
        })
      )}
      <MoreLine more={win.more} pos={sel + 1} total={clients.length} />
    </Tile>
  );
}

function HandshakesView({ rows, cols, sel, cap }: { rows: Handshake[]; cols: number; sel: number; cap: number }) {
  const win = windowOf(rows, sel, cap);
  return (
    <Tile title={`EAPOL CAPTURES (${rows.length})`} led={rows.some((r) => r.eapol) ? "mint" : "amber"} width={cols - 1}>
      <Box>
        <Box width={3}><Text color={TEXT.dim}> </Text></Box>
        <Box width={34}><Text color={TEXT.dim}>FILE</Text></Box>
        <Box width={10}><Text color={TEXT.dim}>SIZE</Text></Box>
        <Box width={7}><Text color={TEXT.dim}>EAPOL</Text></Box>
        <Box><Text color={TEXT.dim}>NETWORKS</Text></Box>
      </Box>
      {rows.length === 0 ? (
        <Text color={TEXT.dim}>no captures yet — handshakes land in ~/warlock/handshakes/</Text>
      ) : (
        win.slice.map((r) => {
          const on = rows.indexOf(r) === sel;
          return (
            <Box key={r.path}>
              <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
              <Box width={34}><Text color={on ? TEXT.hi : TEXT.body} wrap="truncate-end">{r.filename}</Text></Box>
              <Box width={10}><Text color={TEXT.dim}>{(r.size_bytes / 1024).toFixed(1)} KB</Text></Box>
              <Box width={7}><Text color={r.eapol ? COLORS.mint : TEXT.dim}>{r.eapol ? "✓" : "·"}</Text></Box>
              <Box><Text color={COLORS.violet} wrap="truncate-end">{r.networks.slice(0, 2).join(" · ") || "—"}</Text></Box>
            </Box>
          );
        })
      )}
      <MoreLine more={win.more} pos={sel + 1} total={rows.length} />
    </Tile>
  );
}

function ControlView({ running, chanIdx, busy, cols }: { running: boolean; chanIdx: number; busy: boolean; cols: number }) {
  return (
    <Tile title="CAPTURE CONTROL" led={running ? "mint" : "violet"} width={cols - 1}>
      <Box>
        <StatusLED color={running ? "mint" : "dim"} />
        <Text color={TEXT.body}> {running ? "airodump-ng running on mon0" : "idle — ready to start"}</Text>
      </Box>
      <Box>
        <Text color={TEXT.dim}>Channels: </Text>
        {CHAN.map((o, i) => (
          <Text key={o.v} color={i === chanIdx ? COLORS.amber : TEXT.dim}>
            {i === chanIdx ? `[${o.l}] ` : `${o.l} `}
          </Text>
        ))}
      </Box>
      <Box>
        <Text color={!running && !busy ? COLORS.amber : TEXT.dim}>[s] START</Text>
        <Text color={TEXT.dim}>   </Text>
        <Text color={running && !busy ? COLORS.pink : TEXT.dim}>[x] STOP</Text>
        {busy ? <Text color={TEXT.dim}>   ⟳ working…</Text> : null}
      </Box>
    </Tile>
  );
}
