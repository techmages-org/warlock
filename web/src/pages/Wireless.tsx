import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, SignalBars, StatusLED, Tile } from "../components/hud";

// ---------------------------------------------------------------------------
// Guided "Wireless" workflow — WiFi-Pineapple-style single flow that unifies
// recon + offensive + crack against the EXISTING module APIs:
//
//   ① ARM    → wifi_recon/start (monitor + airodump)        [no separate radio step]
//   ② RECON  → poll wifi_recon/aps + /clients (live, sortable)
//   ③ TARGET → click an AP → BSSID/channel/SSID drives next
//   ④ ACT    → wifi_offensive/{deauth,handshake,pmkid,evil_twin,wps} (engagement-gated)
//   ⑤ LOOT   → wifi_recon/handshakes → POST /api/crack/jobs ("Send to Crack")
//
// Frontend-only page (no backend module); routed at /wireless with a manual nav
// entry in App.tsx alongside the auto-generated module rail. Additive — every
// existing tab (WifiRecon, Crack, the offensive stub) is untouched.
// ---------------------------------------------------------------------------

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

type ReconStatus = {
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

// Subset of /api/ops/status — only what the gate banner needs.
type EngStatus = {
  mode: "on" | "off" | string;
  engagement_id: string | null;
  name: string;
  scope: { ssids: string[]; bssids: string[]; ip_ranges: string[] };
};

type StepId = "arm" | "recon" | "target" | "act" | "loot";

const STEPS: { id: StepId; n: string; label: string }[] = [
  { id: "arm", n: "①", label: "ARM" },
  { id: "recon", n: "②", label: "RECON" },
  { id: "target", n: "③", label: "TARGET" },
  { id: "act", n: "④", label: "ACT" },
  { id: "loot", n: "⑤", label: "LOOT" },
];

const CHAN_OPTIONS = [
  { v: "all", l: "All bands" },
  { v: "2.4", l: "2.4 GHz" },
  { v: "5", l: "5 GHz" },
  { v: "1,6,11", l: "2.4 — 1/6/11" },
];

function encColor(enc: string): "mint" | "amber" | "pink" | "violet" {
  if (!enc || enc === "OPN") return "pink";
  if (enc.includes("WEP")) return "pink";
  if (enc.includes("WPA3")) return "mint";
  if (enc.includes("WPA2")) return "violet";
  return "amber";
}

export function Wireless() {
  const [step, setStep] = useState<StepId>("arm");
  const [recon, setRecon] = useState<ReconStatus | null>(null);
  const [eng, setEng] = useState<EngStatus | null>(null);
  const [aps, setAps] = useState<AP[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [hands, setHands] = useState<Handshake[]>([]);
  const [target, setTarget] = useState<AP | null>(null);
  const [note, setNote] = useState<string>("");
  const [channels, setChannels] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"signal" | "channel">("signal");
  const [busy, setBusy] = useState<string | null>(null); // which op is in flight
  const [acted, setActed] = useState(false);

  const running = !!recon?.running;
  const engaged = eng?.mode === "on";

  // --- always-on status poll (drives ARM state, ACT gate, header) -----------
  const refresh = useCallback(async () => {
    try { setRecon(await apiGet<ReconStatus>("/api/wifi_recon/status")); } catch { /**/ }
    try { setEng(await apiGet<EngStatus>("/api/ops/status")); } catch { /**/ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  // --- RECON / TARGET: live AP + client poll --------------------------------
  useEffect(() => {
    if (step !== "recon" && step !== "target") return;
    let alive = true;
    const load = async () => {
      try {
        const a = await apiGet<{ aps: AP[] }>("/api/wifi_recon/aps");
        if (alive) setAps(a.aps || []);
      } catch { /**/ }
      try {
        const c = await apiGet<{ clients: Client[] }>("/api/wifi_recon/clients");
        if (alive) setClients(c.clients || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [step]);

  // --- LOOT: handshakes poll ------------------------------------------------
  useEffect(() => {
    if (step !== "loot") return;
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ handshakes: Handshake[] }>("/api/wifi_recon/handshakes");
        if (alive) setHands(d.handshakes || []);
      } catch { /**/ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [step]);

  // keep the selected target's channel/essid fresh as airodump refines it
  useEffect(() => {
    if (!target) return;
    const live = aps.find((a) => a.bssid === target.bssid);
    if (live && (live.channel !== target.channel || live.essid !== target.essid)) {
      setTarget(live);
    }
  }, [aps, target]);

  const sortedAps = useMemo(() => {
    const copy = [...aps];
    if (sortBy === "signal") copy.sort((a, b) => (b.signal ?? -120) - (a.signal ?? -120));
    else copy.sort((a, b) => (a.channel || 999) - (b.channel || 999));
    return copy;
  }, [aps, sortBy]);

  // --- step completion (purely visual — never drives navigation) ------------
  const done: Record<StepId, boolean> = {
    arm: running,
    recon: !!target,
    target: !!target,
    act: acted,
    loot: hands.length > 0,
  };

  // --- actions (navigation transitions live HERE, in handlers) --------------
  const onArm = async () => {
    setBusy("arm");
    try {
      await apiPost("/api/wifi_recon/start", { channels });
      setNote(`armed — airodump-ng running on monitor iface (${channels})`);
      await refresh();
      setStep("recon"); // auto-advance ONLY from the handler
    } catch (e) { setNote(`arm failed: ${e}`); }
    finally { setBusy(null); }
  };

  const onDisarm = async () => {
    setBusy("disarm");
    try {
      await apiPost("/api/wifi_recon/stop");
      setNote("disarmed — radio returned to managed mode");
      await refresh();
    } catch (e) { setNote(`disarm failed: ${e}`); }
    finally { setBusy(null); }
  };

  const onPick = (ap: AP) => {
    setTarget(ap);
    setNote(`target locked — ${ap.essid || ap.bssid} (ch ${ap.channel || "?"})`);
    setStep("target"); // auto-advance ONLY from the handler
  };

  // unified offensive launcher — every op is engagement-gated server-side.
  const fire = async (op: string, path: string, body: Record<string, unknown>) => {
    setBusy(op);
    try {
      const d = await apiPost<{ job_id?: string }>(path, body);
      setActed(true);
      setNote(`${op} launched — job ${d.job_id ? d.job_id.slice(0, 8) : "?"} (target ${target?.bssid})`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("403")) {
        setNote(
          engaged
            ? `${op} refused (403) — target ${target?.bssid} is not in the active engagement scope. Add it on Operations.`
            : `${op} refused (403) — no active engagement. Activate one on Operations first.`,
        );
      } else {
        setNote(`${op} failed: ${msg}`);
      }
    } finally { setBusy(null); }
  };

  const sendToCrack = async (hs: Handshake) => {
    setBusy(`crack:${hs.filename}`);
    try {
      const d = await apiPost<{ job_id?: string }>("/api/crack/jobs", {
        hashfile: hs.path,
        mode: "22000",
        target: hs.networks[0] || undefined,
      });
      setNote(`queued crack job ${d.job_id ? d.job_id.slice(0, 8) : "?"} — ${hs.filename}. See Crack tab.`);
    } catch (e) {
      const msg = String(e);
      setNote(
        msg.includes("403")
          ? `crack refused (403) — cracking is engagement-gated; activate an engagement with the target in scope.`
          : `send-to-crack failed: ${msg}`,
      );
    } finally { setBusy(null); }
  };

  const stateLabel = recon == null ? "ACQUIRING" : running ? "ARMED" : "SAFE";

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="11 WIRELESS"
        title="Wireless — Guided Flow"
        state={stateLabel}
        icon="⌖"
        right={
          <span className="hud-label text-txt-dim">
            {recon?.iface ?? "—"} · {recon?.aps_seen ?? 0} AP / {recon?.clients_seen ?? 0} STA ·{" "}
            <span className={engaged ? "text-pink-alert" : "text-mint-safe"}>
              {engaged ? "ENGAGED" : "SAFE"}
            </span>
          </span>
        }
      />

      <Stepper step={step} done={done} onGo={setStep} hasTarget={!!target} />

      {note && (
        <div className="hud-tile border-amber-base px-3 py-2 text-amber-base">{note}</div>
      )}

      {step === "arm" && (
        <ArmStep
          recon={recon}
          running={running}
          channels={channels}
          setChannels={setChannels}
          busy={busy}
          onArm={onArm}
          onDisarm={onDisarm}
          onNext={() => setStep("recon")}
        />
      )}

      {step === "recon" && (
        <ReconStep
          running={running}
          aps={sortedAps}
          clients={clients}
          sortBy={sortBy}
          setSortBy={setSortBy}
          targetBssid={target?.bssid ?? null}
          onPick={onPick}
        />
      )}

      {step === "target" && (
        <TargetStep
          target={target}
          clients={clients}
          onBack={() => setStep("recon")}
          onAct={() => setStep("act")}
        />
      )}

      {step === "act" && (
        <ActStep
          target={target}
          engaged={engaged}
          eng={eng}
          busy={busy}
          onFire={fire}
          onBack={() => setStep("recon")}
          onLoot={() => setStep("loot")}
        />
      )}

      {step === "loot" && (
        <LootStep hands={hands} busy={busy} onCrack={sendToCrack} />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Stepper                                                                      //
// --------------------------------------------------------------------------- //
function Stepper({
  step,
  done,
  onGo,
  hasTarget,
}: {
  step: StepId;
  done: Record<StepId, boolean>;
  onGo: (s: StepId) => void;
  hasTarget: boolean;
}) {
  // Permissive navigation: any step is clickable so the operator can revisit.
  // TARGET/ACT just render guidance when no target is selected yet.
  return (
    <div className="flex flex-wrap items-stretch gap-1">
      {STEPS.map((s, i) => {
        const active = step === s.id;
        const complete = done[s.id];
        const gated = (s.id === "target" || s.id === "act") && !hasTarget;
        return (
          <button
            key={s.id}
            onClick={() => onGo(s.id)}
            data-active={active ? "true" : undefined}
            className={
              "hud-btn flex items-center gap-2 " +
              (active ? "border-violet-base text-violet-bright shadow-glow-violet " : "") +
              (gated && !active ? "opacity-60 " : "")
            }
            title={gated ? "select a target in RECON first" : undefined}
          >
            <span className={complete ? "text-mint-safe" : active ? "text-violet-bright" : "text-txt-dim"}>
              {complete ? "✓" : s.n}
            </span>
            <span>{s.label}</span>
            {i < STEPS.length - 1 && <span className="ml-1 text-txt-dim">→</span>}
          </button>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// ① ARM                                                                        //
// --------------------------------------------------------------------------- //
function ArmStep({
  recon,
  running,
  channels,
  setChannels,
  busy,
  onArm,
  onDisarm,
  onNext,
}: {
  recon: ReconStatus | null;
  running: boolean;
  channels: string;
  setChannels: (s: string) => void;
  busy: string | null;
  onArm: () => void;
  onDisarm: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="RADIO" led={running ? "mint" : "amber"}>
          <BigValue value={running ? "ARMED" : "SAFE"} color={running ? "mint" : "amber"} size="md" />
        </Tile>
        <Tile title="IFACE">
          <BigValue value={recon?.iface ?? "—"} color="violet" size="md" />
        </Tile>
        <Tile title="UPTIME">
          <BigValue value={recon?.uptime_s != null ? `${recon.uptime_s}s` : "—"} color="cyan" />
        </Tile>
        <Tile title="INVENTORY">
          <div className="text-txt-body tabular-nums">
            <span className="text-amber-base">{recon?.aps_seen ?? 0}</span> AP
            <span className="mx-1 text-txt-dim">·</span>
            <span className="text-cyan-signal">{recon?.clients_seen ?? 0}</span> STA
          </div>
        </Tile>
      </div>

      <Tile title="ARM THE RADIO" led={running ? "mint" : "violet"}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusLED color={running ? "mint" : "dim"} />
            <span className="text-txt-body">
              {running
                ? "monitor mode active — airodump-ng sweeping"
                : "idle — arming puts the MT7921 dongle into monitor mode and starts the sweep"}
            </span>
          </div>

          <div>
            <label className="hud-label block mb-1">Channels</label>
            <div className="flex flex-wrap gap-2">
              {CHAN_OPTIONS.map((o) => (
                <label key={o.v} className="hud-btn cursor-pointer">
                  <input
                    type="radio"
                    name="wl-chan"
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

          <div className="flex flex-wrap gap-2">
            <button
              className="hud-btn border-amber-base text-amber-base disabled:opacity-40"
              onClick={onArm}
              disabled={running || busy === "arm"}
            >
              {busy === "arm" ? "⟳ ARMING…" : "▶ ARM (monitor + sweep)"}
            </button>
            <button
              className="hud-btn border-pink-alert text-pink-alert disabled:opacity-40"
              onClick={onDisarm}
              disabled={!running || busy === "disarm"}
            >
              {busy === "disarm" ? "⟳ DISARMING…" : "■ DISARM"}
            </button>
            <button
              className="hud-btn border-violet-base text-violet-bright disabled:opacity-40"
              onClick={onNext}
              disabled={!running}
              title={running ? "go to RECON" : "arm first"}
            >
              RECON →
            </button>
          </div>

          <div className="text-txt-dim text-[0.75rem]">
            One action arms the card and starts recon — no separate "turn on the card" step.
            Wraps <code className="text-violet-bright">wifi_recon/start</code>; disarm returns the
            interface to managed mode.
          </div>
        </div>
      </Tile>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// ② RECON                                                                      //
// --------------------------------------------------------------------------- //
function ReconStep({
  running,
  aps,
  clients,
  sortBy,
  setSortBy,
  targetBssid,
  onPick,
}: {
  running: boolean;
  aps: AP[];
  clients: Client[];
  sortBy: "signal" | "channel";
  setSortBy: (s: "signal" | "channel") => void;
  targetBssid: string | null;
  onPick: (ap: AP) => void;
}) {
  return (
    <div className="space-y-4">
      {!running && (
        <div className="hud-tile border-amber-base px-3 py-2 text-amber-base flex items-center gap-2">
          <StatusLED color="amber" />
          <span>radio is not armed — go back to ① ARM to start the sweep. Showing the last results.</span>
        </div>
      )}

      <Tile
        title="ACCESS POINTS — click to target"
        padded={false}
        led={aps.length > 0 ? "mint" : "amber"}
        headerRight={
          <div className="flex items-center gap-1">
            <span className="hud-label text-txt-dim mr-1">sort</span>
            <button
              className="hud-btn px-2 py-0.5 text-[0.7rem]"
              data-active={sortBy === "signal" ? "true" : undefined}
              onClick={() => setSortBy("signal")}
            >
              power
            </button>
            <button
              className="hud-btn px-2 py-0.5 text-[0.7rem]"
              data-active={sortBy === "channel" ? "true" : undefined}
              onClick={() => setSortBy("channel")}
            >
              channel
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
                <th className="hud-label px-3 py-2 text-left">Clients</th>
                <th className="hud-label px-3 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {aps.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-4 text-txt-dim">no APs yet — arm the radio and wait for the sweep</td></tr>
              )}
              {aps.slice(0, 200).map((a) => {
                const ec = encColor(a.encryption);
                const cName = ec === "mint" ? "text-mint-safe" : ec === "amber" ? "text-amber-base" : ec === "pink" ? "text-pink-alert" : "text-violet-bright";
                const nClients = clients.filter((c) => c.associated === a.bssid).length;
                const selected = a.bssid === targetBssid;
                return (
                  <tr
                    key={a.bssid}
                    onClick={() => onPick(a)}
                    className={
                      "cursor-pointer border-b border-line-dim/40 hover:bg-violet-base/10 " +
                      (selected ? "bg-violet-base/15 " : a.wps ? "bg-amber-base/5 " : "")
                    }
                  >
                    <td className="px-3 py-1 text-txt-body tabular-nums">{a.bssid}</td>
                    <td className="px-3 py-1 text-violet-bright">{a.essid || <span className="text-txt-dim">— hidden</span>}</td>
                    <td className="px-3 py-1 tabular-nums text-txt-body">{a.channel || "?"}</td>
                    <td className={"px-3 py-1 " + cName}>
                      {a.encryption || "?"}
                      {a.wps && <span className="ml-1 text-amber-base">WPS</span>}
                    </td>
                    <td className="px-3 py-1">
                      <span className="inline-flex items-center gap-2">
                        <SignalBars value={a.signal} min={-95} max={-30} color="cyan" />
                        <span className="text-cyan-signal tabular-nums">{a.signal}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1 tabular-nums text-txt-dim">{nClients || "—"}</td>
                    <td className="px-3 py-1">
                      <span className={selected ? "text-mint-safe" : "text-violet-bright"}>
                        {selected ? "✓ target" : "select →"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tile>

      <Tile title="STATIONS" padded={false} led={clients.length > 0 ? "cyan" : "amber"}>
        <div className="max-h-64 overflow-auto">
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
              {clients.slice(0, 200).map((c) => (
                <tr key={c.station} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 tabular-nums text-txt-body">{c.station}</td>
                  <td className="px-3 py-1 text-txt-dim tabular-nums">{c.associated ?? "—"}</td>
                  <td className="px-3 py-1 tabular-nums text-cyan-signal">{c.power}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-body">{c.packets}</td>
                  <td className="px-3 py-1 text-txt-dim">{c.probes.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// ③ TARGET                                                                     //
// --------------------------------------------------------------------------- //
function TargetStep({
  target,
  clients,
  onBack,
  onAct,
}: {
  target: AP | null;
  clients: Client[];
  onBack: () => void;
  onAct: () => void;
}) {
  if (!target) {
    return (
      <Tile title="NO TARGET" led="amber">
        <div className="space-y-2 text-txt-body">
          <div>No access point selected yet.</div>
          <div className="text-txt-dim text-[0.8125rem]">
            Go to <span className="text-violet-bright">② RECON</span> and click an AP row to lock it as the target.
          </div>
          <button className="hud-btn border-violet-base text-violet-bright" onClick={onBack}>
            ← RECON
          </button>
        </div>
      </Tile>
    );
  }

  const assoc = clients.filter((c) => c.associated === target.bssid);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile title="ESSID" led="violet">
          <BigValue value={target.essid || "— hidden"} color="violet" size="md" />
        </Tile>
        <Tile title="BSSID">
          <div className="text-txt-body tabular-nums break-all">{target.bssid}</div>
        </Tile>
        <Tile title="CHANNEL">
          <BigValue value={target.channel || "?"} color="cyan" size="md" />
        </Tile>
        <Tile title="ENCRYPTION" led={encColor(target.encryption)}>
          <BigValue
            value={target.encryption || "?"}
            color={encColor(target.encryption)}
            size="md"
          />
          {target.wps && <div className="mt-1 text-amber-base text-[0.75rem]">WPS enabled</div>}
        </Tile>
      </div>

      <Tile title="ASSOCIATED CLIENTS" padded={false} led={assoc.length > 0 ? "cyan" : "dim"}>
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">STA</th>
                <th className="hud-label px-3 py-2 text-left">PWR</th>
                <th className="hud-label px-3 py-2 text-left">PKT</th>
              </tr>
            </thead>
            <tbody>
              {assoc.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-3 text-txt-dim">no associated clients seen on this AP yet</td></tr>
              )}
              {assoc.map((c) => (
                <tr key={c.station} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 tabular-nums text-txt-body">{c.station}</td>
                  <td className="px-3 py-1 tabular-nums text-cyan-signal">{c.power}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-body">{c.packets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>

      <div className="flex flex-wrap gap-2">
        <button className="hud-btn border-violet-base text-violet-bright" onClick={onBack}>
          ← change target
        </button>
        <button className="hud-btn border-amber-base text-amber-base" onClick={onAct}>
          ACT on this target →
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// ④ ACT                                                                        //
// --------------------------------------------------------------------------- //
function ActStep({
  target,
  engaged,
  eng,
  busy,
  onFire,
  onBack,
  onLoot,
}: {
  target: AP | null;
  engaged: boolean;
  eng: EngStatus | null;
  busy: string | null;
  onFire: (op: string, path: string, body: Record<string, unknown>) => void;
  onBack: () => void;
  onLoot: () => void;
}) {
  if (!target) {
    return (
      <Tile title="NO TARGET" led="amber">
        <div className="space-y-2 text-txt-body">
          <div>Select a target before launching an operation.</div>
          <button className="hud-btn border-violet-base text-violet-bright" onClick={onBack}>
            ← RECON
          </button>
        </div>
      </Tile>
    );
  }

  const ch = target.channel || 1;
  const ssid = target.essid || "";
  const noSsid = ssid.trim() === "";

  // Every op is engagement-gated server-side; disable + CTA when mode==off so we
  // never just 403 silently. (An ON-but-out-of-scope target still 403s; that is
  // surfaced via the note from the shared catch in fire().)
  const ops: { op: string; label: string; desc: string; color: string; path: string; body: Record<string, unknown>; disabled?: boolean; hint?: string }[] = [
    {
      op: "deauth", label: "⚡ Deauth", color: "pink",
      desc: "aireplay-ng --deauth burst vs the AP",
      path: "/api/wifi_offensive/deauth", body: { bssid: target.bssid, count: 64 },
    },
    {
      op: "handshake", label: "🤝 Capture Handshake", color: "amber",
      desc: "deauth + airodump EAPOL capture → handshakes/",
      path: "/api/wifi_offensive/handshake", body: { bssid: target.bssid, channel: ch },
    },
    {
      op: "pmkid", label: "🔑 PMKID", color: "cyan",
      desc: "hcxdumptool → .hc22000 (clientless)",
      path: "/api/wifi_offensive/pmkid", body: { bssid: target.bssid, duration: 60 },
    },
    {
      op: "evil_twin", label: "👯 Evil-Twin", color: "violet",
      desc: noSsid ? "needs a visible SSID (target is hidden)" : `airbase-ng rogue AP cloning “${ssid}” + captive portal`,
      path: "/api/wifi_offensive/evil_twin", body: { ssid, channel: ch },
      disabled: noSsid, hint: noSsid ? "hidden SSID — evil-twin needs a name to clone" : undefined,
    },
    {
      op: "wps", label: "📌 WPS PIN", color: "amber",
      desc: target.wps ? "reaver WPS PIN attack" : "reaver WPS PIN attack (AP did not advertise WPS)",
      path: "/api/wifi_offensive/wps", body: { bssid: target.bssid, channel: ch, tool: "reaver" },
    },
  ];

  return (
    <div className="space-y-4">
      {!engaged ? (
        <div className="hud-tile border-pink-alert px-3 py-3 text-pink-alert flex flex-wrap items-center gap-3">
          <StatusLED color="pink" />
          <span className="flex-1">
            <b>Requires an active engagement.</b> Offensive WiFi ops are engagement-gated —
            they will be refused (403) until an engagement is active and this target is in scope.
          </span>
          <Link
            to="/ops"
            className="hud-btn border-cyan-signal text-cyan-signal whitespace-nowrap"
          >
            ◆ Go to Operations →
          </Link>
        </div>
      ) : (
        <div className="hud-tile border-mint-safe px-3 py-2 text-mint-safe flex items-center gap-2">
          <StatusLED color="mint" />
          <span>
            engagement active{eng?.name ? ` — ${eng.name}` : ""}. In-scope ops will launch; an
            out-of-scope target is still refused (403).
          </span>
        </div>
      )}

      <Tile title={`ACT — ${target.essid || target.bssid} (ch ${ch})`} led={engaged ? "pink" : "amber"}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ops.map((o) => {
            const disabled = !engaged || o.disabled || busy === o.op;
            return (
              <button
                key={o.op}
                onClick={() => onFire(o.op, o.path, o.body)}
                disabled={disabled}
                title={o.hint}
                className={
                  `hud-btn flex flex-col items-start gap-1 px-3 py-2 text-left border-${o.color === "pink" ? "pink-alert" : o.color === "amber" ? "amber-base" : o.color === "cyan" ? "cyan-signal" : "violet-base"} ` +
                  "disabled:opacity-40"
                }
              >
                <span className="text-txt-hi">{busy === o.op ? "⟳ launching…" : o.label}</span>
                <span className="text-txt-dim text-[0.72rem]">{o.desc}</span>
              </button>
            );
          })}
        </div>
      </Tile>

      <div className="flex flex-wrap gap-2">
        <button className="hud-btn border-violet-base text-violet-bright" onClick={onBack}>
          ← RECON
        </button>
        <button className="hud-btn border-mint-safe text-mint-safe" onClick={onLoot}>
          LOOT →
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// ⑤ LOOT                                                                       //
// --------------------------------------------------------------------------- //
function LootStep({
  hands,
  busy,
  onCrack,
}: {
  hands: Handshake[];
  busy: string | null;
  onCrack: (hs: Handshake) => void;
}) {
  return (
    <div className="space-y-4">
      <Tile title="CAPTURED HANDSHAKES" padded={false} led={hands.some((h) => h.eapol) ? "mint" : "amber"}>
        <div className="overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line-dim">
                <th className="hud-label px-3 py-2 text-left">File</th>
                <th className="hud-label px-3 py-2 text-left">Size</th>
                <th className="hud-label px-3 py-2 text-left">EAPOL</th>
                <th className="hud-label px-3 py-2 text-left">Networks</th>
                <th className="hud-label px-3 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {hands.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-4 text-txt-dim">
                  no captures yet — run ④ Capture Handshake or PMKID against a target
                </td></tr>
              )}
              {hands.map((h) => (
                <tr key={h.path} className="border-b border-line-dim/40">
                  <td className="px-3 py-1 text-txt-body">{h.filename}</td>
                  <td className="px-3 py-1 tabular-nums text-txt-dim">{(h.size_bytes / 1024).toFixed(1)} KB</td>
                  <td className={"px-3 py-1 " + (h.eapol ? "text-mint-safe" : "text-txt-dim")}>
                    {h.eapol ? "✓" : "·"}
                  </td>
                  <td className="px-3 py-1 text-violet-bright text-[0.75rem]">
                    {h.networks.slice(0, 2).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-1">
                    <button
                      className="hud-btn border-amber-base text-amber-base px-2 py-0.5 text-[0.75rem] disabled:opacity-40"
                      onClick={() => onCrack(h)}
                      disabled={busy === `crack:${h.filename}`}
                    >
                      {busy === `crack:${h.filename}` ? "⟳ queuing…" : "⛓ Send to Crack"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>

      {/* Live activity feed — orchestrator wires <Pager/> here once it lands.
          Placeholder kept so this page renders standalone (no Pager import yet). */}
      <Tile title="LIVE ACTIVITY" led="violet">
        <div
          data-pager-slot="wireless"
          className="text-txt-dim text-[0.8125rem]"
        >
          Pager feed mounts here once the shared <code className="text-violet-bright">Pager</code> component
          is available — jobs, captures, and scope events stream live during the flow.
        </div>
      </Tile>

      <div className="text-txt-dim text-[0.75rem]">
        “Send to Crack” posts the capture path to <code className="text-violet-bright">/api/crack/jobs</code>{" "}
        (mode 22000). Cracking is engagement-gated — track progress on the <span className="text-cyan-signal">Crack</span> tab.
      </div>
    </div>
  );
}
