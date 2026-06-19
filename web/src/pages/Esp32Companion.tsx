// ESP32 Companion — real control interface for the ESP32 Marauder/Hex device.
// Detects USB serial ESP32 devices, connects, scans WiFi, and can launch
// engagement-gated attacks (deauth, beacon spam, probe, rickroll).
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, Tile } from "../components/hud";

type CompanionStatus = {
  module: string;
  label: string;
  connected: boolean;
  device: string | null;
  status: string;
};

type DetectResult = {
  ok: boolean;
  devices: SerialDevice[];
  count: number;
  esp32_candidates: number;
};

type SerialDevice = {
  device: string;
  description: string;
  vid: string | null;
  pid: string | null;
  esp32_candidate: boolean;
};

type CommandResult = {
  ok: boolean;
  output: string;
  command?: string;
  error?: string;
};

type AttackBody = {
  attack_type: string;
  target?: string;
  read_timeout?: number;
};

export function Esp32Companion() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [cmdOutput, setCmdOutput] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [connectDevice, setConnectDevice] = useState("");
  const [baud, setBaud] = useState(115200);
  const [rawCmd, setRawCmd] = useState("");
  const [attackType, setAttackType] = useState("deauth");
  const [attackTarget, setAttackTarget] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await apiGet<CompanionStatus>("/api/esp32_companion/status");
      setStatus(s);
    } catch { /* swallow */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const runDetect = useCallback(async () => {
    setBusy(true);
    try {
      const r = await apiGet<DetectResult>("/api/esp32_companion/detect");
      setDetectResult(r);
      // Auto-select first candidate
      const firstEsp = r.devices.find((d) => d.esp32_candidate);
      if (firstEsp && !connectDevice) setConnectDevice(firstEsp.device);
    } catch (e) {
      setCmdOutput(`Detect failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [connectDevice]);

  const runConnect = useCallback(async () => {
    if (!connectDevice) return;
    setBusy(true);
    setCmdOutput(`Connecting to ${connectDevice} @ ${baud}...`);
    try {
      const r = await apiPost<CommandResult>("/api/esp32_companion/connect", {
        device: connectDevice,
        baud,
      });
      setCmdOutput(r.ok ? `Connected to ${connectDevice}` : `Connect failed: ${r.error || "unknown"}`);
      refresh();
    } catch (e) {
      setCmdOutput(`Connect error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [connectDevice, baud, refresh]);

  const runDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await apiPost<CommandResult>("/api/esp32_companion/disconnect", {});
      setCmdOutput("Disconnected.");
      refresh();
    } catch (e) {
      setCmdOutput(`Disconnect error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const runCommand = useCallback(async (cmd: string, label?: string) => {
    setBusy(true);
    setCmdOutput(`${label || cmd}...`);
    try {
      const r = await apiPost<CommandResult>("/api/esp32_companion/command", {
        command: cmd,
        read_timeout: 10,
      });
      setCmdOutput(r.output || r.error || "(no output)");
    } catch (e) {
      setCmdOutput(`Command error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const runScan = useCallback(async (type: "scanap" | "scansta" | "list") => {
    setBusy(true);
    setCmdOutput(`${type}...`);
    try {
      const r = await apiGet<CommandResult>(`/api/esp32_companion/${type === "list" ? "list" : type}`);
      setCmdOutput(r.output || r.error || "(no output)");
    } catch (e) {
      setCmdOutput(`Scan error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const runAttack = useCallback(async () => {
    setBusy(true);
    setCmdOutput(`Attack: ${attackType}${attackTarget ? ` -> ${attackTarget}` : ""}...`);
    try {
      const r = await apiPost<CommandResult>("/api/esp32_companion/attack", {
        attack_type: attackType,
        target: attackTarget || undefined,
      } as AttackBody);
      setCmdOutput(r.output || r.error || "Attack launched.");
    } catch (e) {
      setCmdOutput(`Attack error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [attackType, attackTarget]);

  const runStop = useCallback(async () => {
    setBusy(true);
    try {
      const r = await apiPost<CommandResult>("/api/esp32_companion/stop", {});
      setCmdOutput(r.output || r.error || "Stopped.");
    } catch (e) {
      setCmdOutput(`Stop error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const connected = status?.connected ?? false;

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="10 ESP-CMP"
        title="ESP32 Companion"
        state={connected ? `LINK: ${status?.device}` : "DISCONNECTED"}
        icon="⌁"
        right={
          <span className="hud-label text-txt-dim">
            {connected ? `● ${status?.device}` : "○ no device"}
          </span>
        }
      />

      {/* Device Detection + Connection */}
      <Tile title="SERIAL LINK" led={connected ? "pink" : "dim"}>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <button className="hud-btn" onClick={runDetect} disabled={busy}>🔍 Detect Devices</button>
          <button className="hud-btn" onClick={runConnect} disabled={busy || !connectDevice}>
            ⚡ Connect
          </button>
          <button className="hud-btn hud-btn-danger" onClick={runDisconnect} disabled={busy || !connected}>
            ⏏ Disconnect
          </button>
          <span className="text-xs text-txt-dim">
            {detectResult ? `${detectResult.count} ports, ${detectResult.esp32_candidates} ESP32 candidates` : ""}
          </span>
        </div>

        {/* Device selector */}
        {detectResult && detectResult.devices.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line-dim">
                  <th className="px-2 py-1 text-left hud-label">port</th>
                  <th className="px-2 py-1 text-left hud-label">description</th>
                  <th className="px-2 py-1 text-left hud-label">VID:PID</th>
                  <th className="px-2 py-1 text-left hud-label">esp32</th>
                  <th className="px-2 py-1 text-left hud-label">baud</th>
                </tr>
              </thead>
              <tbody>
                {detectResult.devices.map((d) => (
                  <tr
                    key={d.device}
                    className={`border-b border-line-dim/40 cursor-pointer ${connectDevice === d.device ? "bg-amber-base/10" : ""}`}
                    onClick={() => { setConnectDevice(d.device); }}
                  >
                    <td className="px-2 py-1 text-violet-bright">{d.device}</td>
                    <td className="px-2 py-1 text-txt-body">{d.description}</td>
                    <td className="px-2 py-1 tabular-nums text-cyan-signal">{d.vid}:{d.pid}</td>
                    <td className="px-2 py-1">{d.esp32_candidate ? <span className="text-mint-safe">✓</span> : <span className="text-txt-dim">—</span>}</td>
                    <td className="px-2 py-1">
                      {connectDevice === d.device && (
                        <input
                          type="number"
                          value={baud}
                          onChange={(e) => setBaud(parseInt(e.target.value) || 115200)}
                          className="w-20 bg-bg-strip border border-line-dim rounded px-1 py-0.5 text-xs text-txt-body"
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tile>

      {/* Recon — Passive scanning (no engagement required) */}
      <Tile title="WIFI RECON" led={connected ? "cyan" : "dim"}>
        <div className="flex flex-wrap items-center gap-3">
          <button className="hud-btn" onClick={() => runScan("scanap")} disabled={busy || !connected}>
            📡 Scan APs
          </button>
          <button className="hud-btn" onClick={() => runScan("scansta")} disabled={busy || !connected}>
            📡 Scan Stations
          </button>
          <button className="hud-btn" onClick={() => runScan("list")} disabled={busy || !connected}>
            📋 List Results
          </button>
          <span className="text-xs text-txt-dim">passive — no engagement required</span>
        </div>
      </Tile>

      {/* Attack — Engagement-gated */}
      <Tile title="OFFENSIVE" led={connected ? "pink" : "dim"} cornerColor={connected ? "var(--pink-alert)" : undefined}>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <select
            value={attackType}
            onChange={(e) => setAttackType(e.target.value)}
            className="bg-bg-strip border border-line-dim rounded px-2 py-1 text-sm text-txt-body"
            disabled={!connected}
          >
            <option value="deauth">Deauth</option>
            <option value="beacon">Beacon Spam</option>
            <option value="probe">Probe Flood</option>
            <option value="rickroll">Rickroll SSIDs</option>
          </select>
          <input
            type="text"
            placeholder="target BSSID (optional)"
            value={attackTarget}
            onChange={(e) => setAttackTarget(e.target.value)}
            className="flex-1 min-w-[200px] bg-bg-strip border border-line-dim rounded px-2 py-1 text-sm text-txt-body font-mono"
            disabled={!connected}
          />
          <button className="hud-btn hud-btn-danger" onClick={runAttack} disabled={busy || !connected}>
            ⚠ LAUNCH
          </button>
          <button className="hud-btn" onClick={runStop} disabled={busy || !connected}>
            ■ STOP
          </button>
          <span className="text-xs text-pink-alert">requires active engagement</span>
        </div>
      </Tile>

      {/* Raw Command Console */}
      <Tile title="SERIAL CONSOLE" led={connected ? "cyan" : "dim"} padded={false}>
        <div className="flex items-center gap-2 p-3 border-b border-line-dim">
          <input
            type="text"
            placeholder="raw Marauder command..."
            value={rawCmd}
            onChange={(e) => setRawCmd(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && rawCmd.trim()) { runCommand(rawCmd.trim()); setRawCmd(""); } }}
            className="flex-1 bg-bg-strip border border-line-dim rounded px-2 py-1 text-sm text-mint-safe font-mono"
            disabled={!connected}
          />
          <button
            className="hud-btn"
            onClick={() => { if (rawCmd.trim()) { runCommand(rawCmd.trim()); setRawCmd(""); } }}
            disabled={busy || !connected || !rawCmd.trim()}
          >
            ↵ SEND
          </button>
          <button className="hud-btn" onClick={() => runCommand("help", "Help")} disabled={busy || !connected}>
            ? HELP
          </button>
        </div>
        {/* Output */}
        <div className="p-3 max-h-[300px] overflow-auto">
          {cmdOutput ? (
            <pre className="text-[0.8125rem] text-mint-safe font-mono whitespace-pre-wrap break-all">{cmdOutput}</pre>
          ) : (
            <span className="text-txt-dim text-sm">awaiting command...</span>
          )}
        </div>
      </Tile>
    </div>
  );
}
