// ============================================================================
// WIRELESS — FLAGSHIP guided flow (frontend-only; no /api/wireless backend).
// Mirrors web Wireless.tsx: a WiFi-Pineapple-style state machine that unifies
// recon + offensive + crack against the EXISTING module APIs:
//   ① ARM    POST /api/wifi_recon/start {channels}     (monitor + airodump sweep)
//   ② RECON  GET  /api/wifi_recon/aps · /clients        (live, selectable)
//   ③ TARGET pick an AP → BSSID/channel/SSID drive the next step
//   ④ ACT    POST /api/wifi_offensive/{deauth,handshake,pmkid,evil_twin,wps}
//   ⑤ LOOT   GET  /api/wifi_recon/handshakes → POST /api/crack/jobs (Send to Crack)
// Engagement state from GET /api/engagements/active gates ④ (pink "!" like web).
//
// Keys (headless-guarded): 1–5 jump step. ARM: ←/→ channels · a arm · d disarm.
//   RECON: ↑/↓ AP · Enter lock. TARGET: Enter → ACT. ACT: ↑/↓ op · Enter fire.
//   LOOT: ↑/↓ capture · Enter send-to-crack.
// ============================================================================

import { Box, Text, useInput, useStdin } from "ink";
import { useEffect, useRef, useState } from "react";
import { BigValue } from "../components/BigValue.js";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";
import type { EngagementStatus } from "../lib/types.js";

const TILE_W = 28;
const FULL_W = TILE_W * 4;

type AP = { bssid: string; essid: string; channel: number; encryption: string; signal: number; wps: boolean };
type Client = { station: string; associated: string | null; probes: string[]; power: number; packets: number };
type Handshake = { filename: string; path: string; size_bytes: number; eapol: boolean; networks: string[] };

type ReconStatus = {
  ok: boolean;
  running: boolean;
  iface: string | null;
  aps_seen: number;
  clients_seen: number;
  uptime_s: number | null;
};

type StepId = "arm" | "recon" | "target" | "act" | "loot";
const STEPS: { id: StepId; n: string; label: string }[] = [
  { id: "arm", n: "1", label: "ARM" },
  { id: "recon", n: "2", label: "RECON" },
  { id: "target", n: "3", label: "TARGET" },
  { id: "act", n: "4", label: "ACT" },
  { id: "loot", n: "5", label: "LOOT" },
];

const CHAN = [
  { v: "all", l: "All bands" },
  { v: "2.4", l: "2.4 GHz" },
  { v: "5", l: "5 GHz" },
  { v: "1,6,11", l: "2.4 — 1/6/11" },
];

type Op = {
  key: string;
  label: string;
  desc: string;
  path: string;
  needsSsid?: boolean;
  build: (t: AP) => Record<string, unknown>;
};
const ACT_OPS: Op[] = [
  { key: "deauth", label: "Deauth", desc: "aireplay-ng deauth burst vs the AP", path: "/api/wifi_offensive/deauth", build: (t) => ({ bssid: t.bssid, count: 64 }) },
  { key: "handshake", label: "Capture HS", desc: "deauth + airodump EAPOL capture", path: "/api/wifi_offensive/handshake", build: (t) => ({ bssid: t.bssid, channel: t.channel || 1 }) },
  { key: "pmkid", label: "PMKID", desc: "hcxdumptool clientless → .hc22000", path: "/api/wifi_offensive/pmkid", build: (t) => ({ bssid: t.bssid, duration: 60 }) },
  { key: "evil_twin", label: "Evil-Twin", desc: "airbase-ng rogue AP cloning SSID + portal", path: "/api/wifi_offensive/evil_twin", needsSsid: true, build: (t) => ({ ssid: t.essid, channel: t.channel || 1 }) },
  { key: "wps", label: "WPS PIN", desc: "reaver WPS PIN attack", path: "/api/wifi_offensive/wps", build: (t) => ({ bssid: t.bssid, channel: t.channel || 1, tool: "reaver" }) },
];

function encColor(enc: string): LEDColor {
  if (!enc || enc === "OPN") return "pink";
  if (enc.includes("WEP")) return "pink";
  if (enc.includes("WPA3")) return "mint";
  if (enc.includes("WPA2")) return "violet";
  return "amber";
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mod = (n: number, m: number) => ((n % m) + m) % m;

function useLive<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export function Screen() {
  const api = useApi();
  const rawOk = !!useStdin().isRawModeSupported;
  const { data: s, error } = usePoll<ReconStatus>(
    () => api.get<ReconStatus>("/api/wifi_recon/status"),
    2000,
    [api],
  );

  const [step, setStep] = useState<StepId>("arm");
  const [eng, setEng] = useState<EngagementStatus | null>(null);
  const [aps, setAps] = useState<AP[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [hands, setHands] = useState<Handshake[]>([]);
  const [target, setTarget] = useState<AP | null>(null);
  const [chanIdx, setChanIdx] = useState(0);
  const [apIdx, setApIdx] = useState(0);
  const [opIdx, setOpIdx] = useState(0);
  const [handIdx, setHandIdx] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [acted, setActed] = useState(false);

  // Engagement state (drives the ④ ACT gate) — silent degrade.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const e = await api.get<EngagementStatus>("/api/engagements/active");
        if (alive) setEng(e);
      } catch {
        /* silent */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api]);

  // RECON/TARGET: live AP + client poll.
  useEffect(() => {
    if (step !== "recon" && step !== "target") return;
    let alive = true;
    const load = async () => {
      try {
        const a = await api.get<{ aps: AP[] }>("/api/wifi_recon/aps");
        if (alive) setAps(a.aps || []);
      } catch {
        /* silent */
      }
      try {
        const c = await api.get<{ clients: Client[] }>("/api/wifi_recon/clients");
        if (alive) setClients(c.clients || []);
      } catch {
        /* silent */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, step]);

  // LOOT: handshakes poll.
  useEffect(() => {
    if (step !== "loot") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await api.get<{ handshakes: Handshake[] }>("/api/wifi_recon/handshakes");
        if (alive) setHands(d.handshakes || []);
      } catch {
        /* silent */
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, step]);

  // Keep the locked target fresh as airodump refines its channel/essid.
  useEffect(() => {
    if (!target) return;
    const live = aps.find((a) => a.bssid === target.bssid);
    if (live && (live.channel !== target.channel || live.essid !== target.essid)) setTarget(live);
  }, [aps, target]);

  const running = !!s?.running;
  const engaged = eng?.mode === "on";

  const stepRef = useLive(step);
  const chanIdxRef = useLive(chanIdx);
  const apIdxRef = useLive(apIdx);
  const opIdxRef = useLive(opIdx);
  const handIdxRef = useLive(handIdx);
  const apsRef = useLive(aps);
  const handsRef = useLive(hands);
  const targetRef = useLive(target);
  const runningRef = useLive(running);
  const engagedRef = useLive(engaged);
  const busyRef = useLive(busy);

  const onArm = async () => {
    setBusy(true);
    try {
      const ch = CHAN[chanIdxRef.current].v;
      await api.post("/api/wifi_recon/start", { channels: ch });
      setNote(`armed — airodump-ng sweeping on monitor iface (${ch})`);
      setStep("recon");
    } catch (e) {
      setNote(`arm failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };
  const onDisarm = async () => {
    setBusy(true);
    try {
      await api.post("/api/wifi_recon/stop");
      setNote("disarmed — radio returned to managed mode");
    } catch (e) {
      setNote(`disarm failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const lockTarget = () => {
    const list = apsRef.current;
    const ap = list[clamp(apIdxRef.current, 0, Math.max(0, list.length - 1))];
    if (!ap) {
      setNote("no AP to lock yet — wait for the sweep to populate");
      return;
    }
    setTarget(ap);
    setNote(`target locked — ${ap.essid || ap.bssid} (ch ${ap.channel || "?"})`);
    setStep("target");
  };

  const fire = async () => {
    const t = targetRef.current;
    if (!t) {
      setNote("no target — go to ② RECON and lock an AP");
      return;
    }
    const op = ACT_OPS[clamp(opIdxRef.current, 0, ACT_OPS.length - 1)];
    if (!engagedRef.current) {
      setNote(`! ${op.label} blocked — no active engagement. Ctrl+E → Operations to activate.`);
      return;
    }
    if (op.needsSsid && !t.essid) {
      setNote("evil-twin needs a visible SSID — the target is hidden");
      return;
    }
    setBusy(true);
    try {
      const d = await api.post<{ job_id?: string }>(op.path, op.build(t));
      setActed(true);
      setNote(`${op.label} launched — job ${d.job_id ? d.job_id.slice(0, 8) : "?"} vs ${t.bssid}`);
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? `${op.label} refused (403) — ${engagedRef.current ? "target not in engagement scope" : "no active engagement"}.`
          : `${op.label} failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const sendToCrack = async () => {
    const list = handsRef.current;
    const hs = list[clamp(handIdxRef.current, 0, Math.max(0, list.length - 1))];
    if (!hs) {
      setNote("no capture selected — run ④ Capture HS / PMKID first");
      return;
    }
    setBusy(true);
    try {
      const d = await api.post<{ job_id?: string }>("/api/crack/jobs", {
        hashfile: hs.path,
        mode: "22000",
        target: hs.networks[0] || undefined,
      });
      setNote(`queued crack ${d.job_id ? d.job_id.slice(0, 8) : "?"} — ${hs.filename}. Track it on Crack (g c).`);
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? "crack refused (403) — engagement-gated; activate an engagement with the target in scope."
          : `send-to-crack failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (input, key) => {
      if (input >= "1" && input <= "5") {
        setStep(STEPS[Number(input) - 1].id);
        return;
      }
      const st = stepRef.current;
      if (st === "arm") {
        if (key.leftArrow || key.rightArrow) {
          const dir = key.leftArrow ? -1 : 1;
          setChanIdx((i) => mod(i + dir, CHAN.length));
        } else if (input === "a" && !runningRef.current && !busyRef.current) void onArm();
        else if (input === "d" && runningRef.current && !busyRef.current) void onDisarm();
      } else if (st === "recon") {
        const n = apsRef.current.length;
        if (key.upArrow) setApIdx((v) => clamp(v - 1, 0, Math.max(0, n - 1)));
        else if (key.downArrow) setApIdx((v) => clamp(v + 1, 0, Math.max(0, n - 1)));
        else if (key.return) lockTarget();
      } else if (st === "target") {
        if (key.return) setStep("act");
      } else if (st === "act") {
        if (key.upArrow) setOpIdx((v) => clamp(v - 1, 0, ACT_OPS.length - 1));
        else if (key.downArrow) setOpIdx((v) => clamp(v + 1, 0, ACT_OPS.length - 1));
        else if (key.return && !busyRef.current) void fire();
      } else if (st === "loot") {
        const n = handsRef.current.length;
        if (key.upArrow) setHandIdx((v) => clamp(v - 1, 0, Math.max(0, n - 1)));
        else if (key.downArrow) setHandIdx((v) => clamp(v + 1, 0, Math.max(0, n - 1)));
        else if (key.return && !busyRef.current) void sendToCrack();
      }
    },
    { isActive: rawOk },
  );

  if (error) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="11 WIRELESS" title="Wireless — Guided Flow" state="LINK ERROR" icon="⌖" />
        <Tile title="ERROR" led="pink" width={TILE_W * 2}>
          <Text color={COLORS.pink}>wireless error: {error}</Text>
        </Tile>
      </Box>
    );
  }

  if (!s) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="11 WIRELESS" title="Wireless — Guided Flow" state="ACQUIRING" icon="⌖" />
        <Tile title="BOOT" led="amber" width={TILE_W}>
          <Text color={TEXT.dim}>acquiring radio state…</Text>
        </Tile>
      </Box>
    );
  }

  const stateLabel = running ? "ARMED" : "SAFE";
  const ti = aps.length ? clamp(apIdx, 0, aps.length - 1) : 0;
  const oi = clamp(opIdx, 0, ACT_OPS.length - 1);
  const hidx = hands.length ? clamp(handIdx, 0, hands.length - 1) : 0;

  const done: Record<StepId, boolean> = {
    arm: running,
    recon: !!target,
    target: !!target,
    act: acted,
    loot: hands.length > 0,
  };

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="11 WIRELESS"
        title="Wireless — Guided Flow"
        state={stateLabel}
        icon="⌖"
        right={
          <Text>
            <Text color={TEXT.dim}>{s?.iface ?? "—"} · {s?.aps_seen ?? 0} AP / {s?.clients_seen ?? 0} STA · </Text>
            <Text color={engaged ? COLORS.pink : COLORS.mint}>{engaged ? "ENGAGED" : "SAFE"}</Text>
          </Text>
        }
      />

      {/* Stepper */}
      <Box>
        {STEPS.map((st, i) => {
          const active = step === st.id;
          const complete = done[st.id];
          return (
            <Box key={st.id} marginRight={1}>
              <Text
                bold={active}
                color={complete ? COLORS.mint : active ? COLORS.violet : TEXT.dim}
                backgroundColor={active ? "#1e1b2e" : undefined}
              >
                {complete ? "✓" : st.n} {st.label}
              </Text>
              {i < STEPS.length - 1 ? <Text color={TEXT.dim}> → </Text> : null}
            </Box>
          );
        })}
      </Box>

      {note ? (
        <Box>
          <Text color={note.startsWith("!") ? COLORS.pink : COLORS.amber}>» {note}</Text>
        </Box>
      ) : null}

      {step === "arm" && <ArmStep s={s} running={running} chanIdx={chanIdx} busy={busy} />}
      {step === "recon" && <ReconStep running={running} aps={aps} clients={clients} sel={ti} />}
      {step === "target" && <TargetStep target={target} clients={clients} />}
      {step === "act" && <ActStep target={target} engaged={engaged} eng={eng} sel={oi} busy={busy} />}
      {step === "loot" && <LootStep hands={hands} sel={hidx} busy={busy} />}

      <Box>
        <Text color={TEXT.dim}>{HINTS[step]}</Text>
      </Box>
    </Box>
  );
}

const HINTS: Record<StepId, string> = {
  arm: "1–5 step · ←/→ channels · a arm · d disarm",
  recon: "1–5 step · ↑/↓ select AP · Enter lock target",
  target: "1–5 step · Enter → ACT",
  act: "1–5 step · ↑/↓ op · Enter fire (gated)",
  loot: "1–5 step · ↑/↓ capture · Enter send-to-crack",
};

// --------------------------------------------------------------------------- //
function ArmStep({ s, running, chanIdx, busy }: { s: ReconStatus | null; running: boolean; chanIdx: number; busy: boolean }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Tile title="RADIO" led={running ? "mint" : "amber"} width={TILE_W}>
          <BigValue value={running ? "ARMED" : "SAFE"} color={running ? "mint" : "amber"} />
        </Tile>
        <Tile title="IFACE" led="violet" width={TILE_W}>
          <BigValue value={s?.iface ?? "—"} color="violet" />
        </Tile>
        <Tile title="UPTIME" led="cyan" width={TILE_W}>
          <BigValue value={s?.uptime_s != null ? `${s.uptime_s}` : "—"} unit="s" color="cyan" />
        </Tile>
        <Tile title="INVENTORY" led="amber" width={TILE_W}>
          <Text>
            <Text color={COLORS.amber}>{s?.aps_seen ?? 0}</Text>
            <Text color={TEXT.dim}> AP · </Text>
            <Text color={COLORS.cyan}>{s?.clients_seen ?? 0}</Text>
            <Text color={TEXT.dim}> STA</Text>
          </Text>
        </Tile>
      </Box>
      <Tile title="ARM THE RADIO" led={running ? "mint" : "violet"} width={FULL_W}>
        <Box>
          <StatusLED color={running ? "mint" : "dim"} />
          <Text color={TEXT.body}>
            {" "}
            {running ? "monitor mode active — airodump-ng sweeping" : "idle — one action puts the dongle in monitor mode and starts the sweep"}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={TEXT.dim}>Channels: </Text>
          {CHAN.map((o, i) => (
            <Text key={o.v} color={i === chanIdx ? COLORS.amber : TEXT.dim}>
              {i === chanIdx ? `[${o.l}] ` : `${o.l} `}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={!running && !busy ? COLORS.amber : TEXT.dim}>[a] ▶ ARM (monitor + sweep)</Text>
          <Text color={TEXT.dim}>   </Text>
          <Text color={running && !busy ? COLORS.pink : TEXT.dim}>[d] ■ DISARM</Text>
          {busy ? <Text color={TEXT.dim}>   ⟳ working…</Text> : null}
        </Box>
      </Tile>
    </Box>
  );
}

function ReconStep({ running, aps, clients, sel }: { running: boolean; aps: AP[]; clients: Client[]; sel: number }) {
  return (
    <Box flexDirection="column">
      {!running ? (
        <Box>
          <StatusLED color="amber" />
          <Text color={COLORS.amber}> radio not armed — go to ① ARM to start the sweep (showing last results)</Text>
        </Box>
      ) : null}
      <Tile title={`ACCESS POINTS — Enter to target (${aps.length})`} led={aps.length ? "mint" : "amber"} width={FULL_W}>
        <Box>
          <Box width={3}><Text color={TEXT.dim}> </Text></Box>
          <Box width={20}><Text color={TEXT.dim}>BSSID</Text></Box>
          <Box width={20}><Text color={TEXT.dim}>ESSID</Text></Box>
          <Box width={5}><Text color={TEXT.dim}>CH</Text></Box>
          <Box width={10}><Text color={TEXT.dim}>ENC</Text></Box>
          <Box width={6}><Text color={TEXT.dim}>SIG</Text></Box>
          <Box><Text color={TEXT.dim}>STA</Text></Box>
        </Box>
        {aps.length === 0 ? (
          <Text color={TEXT.dim}>no APs yet — arm the radio and wait for the sweep</Text>
        ) : (
          aps.slice(0, 6).map((a, idx) => {
            const on = idx === sel;
            const nClients = clients.filter((c) => c.associated === a.bssid).length;
            return (
              <Box key={a.bssid}>
                <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
                <Box width={20}><Text color={on ? TEXT.hi : TEXT.body}>{a.bssid}</Text></Box>
                <Box width={20}><Text color={a.essid ? COLORS.violet : TEXT.dim} wrap="truncate-end">{a.essid || "— hidden"}</Text></Box>
                <Box width={5}><Text color={TEXT.body}>{a.channel || "?"}</Text></Box>
                <Box width={10}><Text color={COLORS[encColor(a.encryption)]}>{a.encryption || "?"}{a.wps ? " W" : ""}</Text></Box>
                <Box width={6}><Text color={COLORS.cyan}>{a.signal}</Text></Box>
                <Box><Text color={TEXT.dim}>{nClients || "—"}</Text></Box>
              </Box>
            );
          })
        )}
      </Tile>
      <Tile title={`STATIONS (${clients.length})`} led={clients.length ? "cyan" : "dim"} width={FULL_W}>
        {clients.length === 0 ? (
          <Text color={TEXT.dim}>no clients yet</Text>
        ) : (
          clients.slice(0, 3).map((c) => (
            <Box key={c.station}>
              <Box width={20}><Text color={TEXT.body}>{c.station}</Text></Box>
              <Box width={20}><Text color={TEXT.dim}>{c.associated ?? "—"}</Text></Box>
              <Box width={6}><Text color={COLORS.cyan}>{c.power}</Text></Box>
              <Box><Text color={TEXT.dim} wrap="truncate-end">{c.probes.join(", ") || "—"}</Text></Box>
            </Box>
          ))
        )}
      </Tile>
    </Box>
  );
}

function TargetStep({ target, clients }: { target: AP | null; clients: Client[] }) {
  if (!target) {
    return (
      <Tile title="NO TARGET" led="amber" width={FULL_W}>
        <Text color={TEXT.body}>No access point selected yet.</Text>
        <Text color={TEXT.dim}>Go to ② RECON (press 2) and Enter on an AP row to lock it.</Text>
      </Tile>
    );
  }
  const assoc = clients.filter((c) => c.associated === target.bssid);
  return (
    <Box flexDirection="column">
      <Box>
        <Tile title="ESSID" led="violet" width={TILE_W}>
          <BigValue value={target.essid || "— hidden"} color="violet" />
        </Tile>
        <Tile title="BSSID" led="cyan" width={TILE_W}>
          <BigValue value={target.bssid} color="cyan" />
        </Tile>
        <Tile title="CHANNEL" led="cyan" width={TILE_W}>
          <BigValue value={target.channel || "?"} color="cyan" />
        </Tile>
        <Tile title="ENCRYPTION" led={encColor(target.encryption)} width={TILE_W}>
          <BigValue value={target.encryption || "?"} color={encColor(target.encryption)} />
          {target.wps ? <Text color={COLORS.amber}>WPS enabled</Text> : null}
        </Tile>
      </Box>
      <Tile title={`ASSOCIATED CLIENTS (${assoc.length})`} led={assoc.length ? "cyan" : "dim"} width={FULL_W}>
        {assoc.length === 0 ? (
          <Text color={TEXT.dim}>no associated clients seen on this AP yet</Text>
        ) : (
          assoc.slice(0, 4).map((c) => (
            <Box key={c.station}>
              <Box width={20}><Text color={TEXT.body}>{c.station}</Text></Box>
              <Box width={8}><Text color={COLORS.cyan}>{c.power}</Text></Box>
              <Box><Text color={TEXT.dim}>{c.packets} pkt</Text></Box>
            </Box>
          ))
        )}
      </Tile>
      <Box>
        <Text color={COLORS.amber}>[Enter] ACT on this target →</Text>
      </Box>
    </Box>
  );
}

function ActStep({ target, engaged, eng, sel, busy }: { target: AP | null; engaged: boolean; eng: EngagementStatus | null; sel: number; busy: boolean }) {
  if (!target) {
    return (
      <Tile title="NO TARGET" led="amber" width={FULL_W}>
        <Text color={TEXT.body}>Select a target before launching an operation.</Text>
        <Text color={TEXT.dim}>Press 2 → RECON and Enter on an AP.</Text>
      </Tile>
    );
  }
  return (
    <Box flexDirection="column">
      {engaged ? (
        <Text>
          <Text color={COLORS.mint}>◎ engagement active{eng?.name ? ` — ${eng.name}` : ""}</Text>
          <Text color={TEXT.body}>. In-scope ops launch; an out-of-scope target still 403s.</Text>
        </Text>
      ) : (
        <Text>
          <Text bold color={COLORS.pink}>! REQUIRES AN ACTIVE ENGAGEMENT</Text>
          <Text color={TEXT.body}> — offensive ops are gated and refused (403) until an engagement is active. Ctrl+E → Operations.</Text>
        </Text>
      )}
      <Tile title={`ACT — ${target.essid || target.bssid} (ch ${target.channel || "?"})`} led={engaged ? "pink" : "amber"} width={FULL_W}>
        {ACT_OPS.map((op, idx) => {
          const on = idx === sel;
          const blocked = !engaged || (op.needsSsid && !target.essid);
          return (
            <Box key={op.key}>
              <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
              <Box width={13}><Text color={blocked ? TEXT.dim : COLORS.amber}>{op.label}</Text></Box>
              <Box width={8}><Text color={blocked ? COLORS.pink : COLORS.mint}>{blocked ? "BLOCKED" : "ready"}</Text></Box>
              <Box><Text color={TEXT.dim} wrap="truncate-end">{op.desc}</Text></Box>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={busy ? TEXT.dim : engaged ? COLORS.pink : TEXT.dim}>{busy ? "⟳ launching…" : "[Enter] ▶ FIRE · press 5 → LOOT"}</Text>
        </Box>
      </Tile>
    </Box>
  );
}

function LootStep({ hands, sel, busy }: { hands: Handshake[]; sel: number; busy: boolean }) {
  return (
    <Box flexDirection="column">
      <Tile title={`CAPTURED HANDSHAKES — Enter to crack (${hands.length})`} led={hands.some((h) => h.eapol) ? "mint" : "amber"} width={FULL_W}>
        <Box>
          <Box width={3}><Text color={TEXT.dim}> </Text></Box>
          <Box width={32}><Text color={TEXT.dim}>FILE</Text></Box>
          <Box width={10}><Text color={TEXT.dim}>SIZE</Text></Box>
          <Box width={7}><Text color={TEXT.dim}>EAPOL</Text></Box>
          <Box><Text color={TEXT.dim}>NETWORKS</Text></Box>
        </Box>
        {hands.length === 0 ? (
          <Text color={TEXT.dim}>no captures yet — run ④ Capture HS or PMKID against a target</Text>
        ) : (
          hands.slice(0, 6).map((h, idx) => {
            const on = idx === sel;
            return (
              <Box key={h.path}>
                <Box width={3}><Text color={on ? COLORS.violet : TEXT.dim}>{on ? "› " : "  "}</Text></Box>
                <Box width={32}><Text color={on ? TEXT.hi : TEXT.body} wrap="truncate-end">{h.filename}</Text></Box>
                <Box width={10}><Text color={TEXT.dim}>{(h.size_bytes / 1024).toFixed(1)} KB</Text></Box>
                <Box width={7}><Text color={h.eapol ? COLORS.mint : TEXT.dim}>{h.eapol ? "✓" : "·"}</Text></Box>
                <Box><Text color={COLORS.violet} wrap="truncate-end">{h.networks.slice(0, 2).join(" · ") || "—"}</Text></Box>
              </Box>
            );
          })
        )}
        <Box marginTop={1}>
          <Text color={busy ? TEXT.dim : COLORS.amber}>{busy ? "⟳ queuing…" : "[Enter] ⛓ Send to Crack (mode 22000) — engagement-gated"}</Text>
        </Box>
      </Tile>
    </Box>
  );
}
