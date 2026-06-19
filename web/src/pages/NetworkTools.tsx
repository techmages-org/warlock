// NetworkTools — the "Fluke on steroids" network dashboard.
// One-click network discovery: link health, LLDP switch ID, gateway/DNS/DHCP,
// ARP sweep of all hosts with OUI-based device classification, port scanning.
//
// Backed by existing netdiag + net_recon + nettools APIs.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { BigValue, ModuleHeader, Tile, type LEDColor } from "../components/hud";

/* ---------------------- types ---------------------- */

type HealthResp = {
  ok: boolean;
  iface: string;
  verdict: { overall: string; checks: { check: string; verdict: string; detail: string }[] };
  link: {
    iface: string;
    carrier: boolean;
    operstate: string;
    speed_mbps: number;
    mtu: number;
    wired?: { speed: string; duplex: string; port: string } | null;
  };
  services: {
    dhcp: { has_lease: boolean; gateway: string; detail: string };
    dns: { available: boolean; resolved: boolean; ms: number; answers: string[] };
    gateway: { available: boolean; gateway: string; loss_pct: number; rtt_avg_ms: number; rtt_max_ms: number; jitter_ms: number };
  };
  path?: { path_mtu?: { path_mtu: number } } | null;
};

type NeighborResp = {
  ok: boolean;
  available: boolean;
  neighbors: { local_port: string; switch: string; port_id: string; port_descr: string; vlan: string }[];
};

type ArpScanResp = {
  ok: boolean;
  subnet: string;
  summary: { up: number; down: number; total: number };
  hosts: Host[];
};

type Host = {
  ip: string;
  mac: string;
  vendor: string;
  hostname: string;
  ports: { port: number; proto: string; state: string; service: string }[];
  os_guess: string;
};

type PortScanResp = {
  ok: boolean;
  scan_id?: number;
  results?: { ip: string; ports: { port: number; proto: string; state: string; service: string }[] }[];
};

type SubnetResp = {
  ok: boolean;
  network: string;
  prefix: number;
  netmask: string;
  broadcast: string;
  total_addresses: number;
  usable_hosts: number;
  first_host: string;
  last_host: string;
  version: number;
};

/* ---------------------- device classification ---------------------- */

type DevType = "Router" | "Switch" | "AP" | "NAS" | "Server" | "VoIP" | "IoT" | "Client" | "Unknown";

const TYPE_ICON: Record<DevType, string> = {
  Router: "🔀", Switch: "tore", AP: "📡", NAS: "💾", Server: "🖥",
  VoIP: "☎", IoT: "🔧", Client: "💻", Unknown: "❓",
};

const TYPE_COLOR: Record<DevType, string> = {
  Router: "text-violet-bright", Switch: "text-cyan-signal", AP: "text-cyan-signal",
  NAS: "text-amber-base", Server: "text-mint-safe", VoIP: "text-pink-alert",
  IoT: "text-orange-warn", Client: "text-txt-body", Unknown: "text-txt-dim",
};

function classifyDevice(host: Host, gateway: string): DevType {
  // Gateway = router/firewall
  if (host.ip === gateway) return "Router";

  const vendor = host.vendor.toLowerCase();
  const portNums = host.ports.filter(p => p.state === "open").map(p => p.port);

  // NAS indicators
  if (portNums.some(p => [445, 2049, 5000, 5001, 9000, 9091].includes(p))) return "NAS";

  // VoIP phones
  if (vendor.includes("yealink") || vendor.includes("grandstream") || vendor.includes("polycom") ||
      portNums.includes(5060)) return "VoIP";

  // Servers
  if (portNums.some(p => [22, 3389, 8080, 8443, 9090, 6443].includes(p))) return "Server";
  if (portNums.includes(443) && portNums.includes(80)) return "Server";

  // Switches / APs by vendor
  if (vendor.includes("ubiquiti")) return "Switch";
  if (vendor.includes("cisco") || vendor.includes("aruba") || vendor.includes("hpe") ||
      vendor.includes("netgear") || vendor.includes("tp-link") || vendor.includes("d-link")) return "Switch";
  if (vendor.includes("gl technologies")) return "Router";

  // IoT
  if (vendor.includes("espressif") || vendor.includes("tuya") || vendor.includes("shenzhen")) return "IoT";

  return "Unknown";
}

/* ---------------------- helpers ---------------------- */

function verdictColor(v: string): string {
  if (v === "PASS") return "text-mint-safe";
  if (v === "WARN") return "text-amber-base";
  return "text-pink-alert";
}

function verdictLed(v: string): LEDColor {
  if (v === "PASS") return "cyan";
  if (v === "WARN") return "amber";
  return "pink";
}

/* ---------------------- main component ---------------------- */

export function NetworkTools() {
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [neighbors, setNeighbors] = useState<NeighborResp | null>(null);
  const [scanResult, setScanResult] = useState<ArpScanResp | null>(null);
  const [subnet, setSubnet] = useState<SubnetResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const [hostPorts, setHostPorts] = useState<PortScanResp | null>(null);
  const [status, setStatus] = useState<{ iface: string; gateway: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initial status fetch
  useEffect(() => {
    apiGet<{ iface: string; gateway: string }>("/api/netdiag/status")
      .then(s => setStatus(s))
      .catch(() => {});
  }, []);

  // One-click discover
  const discover = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [h, n, s] = await Promise.all([
        apiPost<HealthResp>("/api/netdiag/health", { iface: "eth0" }),
        apiPost<NeighborResp>("/api/netdiag/neighbors", { iface: "eth0" }),
        apiPost<ArpScanResp>("/api/net_recon/arpscan", {}),
      ]);
      setHealth(h);
      setNeighbors(n);
      setScanResult(s);

      // Fetch subnet info
      if (s.subnet) {
        apiPost<SubnetResp>("/api/nettools/subnet", { cidr: s.subnet })
          .then(setSubnet).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Quick port scan on a single host
  const scanHost = useCallback(async (ip: string) => {
    setScanning(ip);
    try {
      const r = await apiPost<PortScanResp>("/api/net_recon/portscan", {
        targets: ip,
        profile: "service",
      });
      setHostPorts(r);
      // Update the selected host's ports
      if (r.results && r.results.length > 0) {
        setSelectedHost(prev => prev ? { ...prev, ports: r.results![0].ports } : prev);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(null);
    }
  }, []);

  const gateway = health?.services?.gateway?.gateway || status?.gateway || "";
  const iface = status?.iface || "eth0";

  // Group hosts by type
  const hosts = scanResult?.hosts || [];
  const gateway_ip = gateway;

  const grouped: Record<string, Host[]> = {};
  for (const h of hosts) {
    const t = classifyDevice(h, gateway_ip);
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(h);
  }

  const order: DevType[] = ["Router", "Switch", "AP", "NAS", "Server", "VoIP", "IoT", "Client", "Unknown"];

  return (
    <div className="space-y-4">
      <ModuleHeader
        code="06 NET-TOOLS"
        title="Network Tools"
        state={busy ? "SCANNING" : scanResult ? `${scanResult.summary.up} HOSTS` : "READY"}
        icon="🔧"
        right={
          <div className="flex items-center gap-3">
            {gateway && <span className="hud-label text-txt-dim">{iface} · gw {gateway}</span>}
            <button
              className="hud-btn"
              onClick={discover}
              disabled={busy}
            >
              {busy ? "⟳ Discovering..." : "⚡ Discover Network"}
            </button>
          </div>
        }
      />

      {error && (
        <div className="border border-pink-alert/40 bg-pink-alert/10 rounded-lg px-4 py-2 text-sm text-pink-alert">
          Error: {error}
        </div>
      )}

      {/* Health verdict + link summary */}
      {health && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Verdict badge */}
          <Tile title="HEALTH" led={verdictLed(health.verdict.overall)}>
            <div className="flex flex-col items-center justify-center py-2">
              <span className={`text-3xl font-bold ${verdictColor(health.verdict.overall)}`}>
                {health.verdict.overall}
              </span>
              <div className="mt-2 space-y-0.5">
                {health.verdict.checks.map((c) => (
                  <div key={c.check} className="flex items-center justify-between gap-4 text-xs">
                    <span className="text-txt-dim">{c.check}</span>
                    <span className={verdictColor(c.verdict)}>{c.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </Tile>

          {/* Link info */}
          <Tile title="LINK" led="cyan">
            <div className="space-y-1 text-sm">
              <BigValue
                value={`${health.link.speed_mbps}`}
                unit="Mb/s"
                color="cyan"
              />
              <div className="text-xs text-txt-dim text-center -mt-1">Speed</div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Duplex</span>
                <span className="text-txt-body">{health.link.wired?.duplex || "?"}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">MTU</span>
                <span className="text-txt-body">{health.link.mtu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Carrier</span>
                <span className={health.link.carrier ? "text-mint-safe" : "text-pink-alert"}>
                  {health.link.carrier ? "UP" : "DOWN"}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Port</span>
                <span className="text-txt-body">{health.link.wired?.port || "?"}</span>
              </div>
            </div>
          </Tile>

          {/* Switch / LLDP */}
          <Tile title="SWITCH (LLDP)" led={neighbors?.neighbors?.length ? "cyan" : "dim"}>
            {neighbors?.neighbors && neighbors.neighbors.length > 0 ? (
              <div className="space-y-1 text-sm">
                {neighbors.neighbors.map((n, i) => (
                  <div key={i}>
                    <div className="text-violet-bright font-bold text-base">{n.switch}</div>
                    <div className="flex justify-between text-xs">
                      <span className="text-txt-dim">Port</span>
                      <span className="text-txt-body">{n.port_id}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-txt-dim">VLAN</span>
                      <span className="text-amber-base">{n.vlan}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-txt-dim text-sm">No LLDP neighbors</span>
            )}
          </Tile>
        </div>
      )}

      {/* Infrastructure detail: gateway/DNS/DHCP + subnet */}
      {health && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Tile title="GATEWAY" led="cyan">
            <div className="space-y-0.5 text-sm">
              <div className="text-violet-bright font-mono text-base">{health.services.gateway.gateway}</div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Loss</span>
                <span className={health.services.gateway.loss_pct > 0 ? "text-amber-base" : "text-mint-safe"}>
                  {health.services.gateway.loss_pct}%
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">RTT avg</span>
                <span className="text-cyan-signal">{health.services.gateway.rtt_avg_ms}ms</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">RTT max</span>
                <span className="text-txt-body">{health.services.gateway.rtt_max_ms}ms</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Jitter</span>
                <span className="text-txt-body">{health.services.gateway.jitter_ms}ms</span>
              </div>
            </div>
          </Tile>

          <Tile title="DNS" led={health.services.dns.resolved ? "cyan" : "pink"}>
            <div className="space-y-0.5 text-sm">
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Resolved</span>
                <span className={health.services.dns.resolved ? "text-mint-safe" : "text-pink-alert"}>
                  {health.services.dns.resolved ? "YES" : "FAIL"}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">RTT</span>
                <span className="text-cyan-signal">{health.services.dns.ms}ms</span>
              </div>
              <div className="mt-1 text-xs text-txt-dim">Answers:</div>
              {health.services.dns.answers.map((a, i) => (
                <div key={i} className="text-xs font-mono text-amber-base pl-2">{a}</div>
              ))}
            </div>
          </Tile>

          <Tile title="DHCP" led={health.services.dhcp.has_lease ? "cyan" : "amber"}>
            <div className="space-y-0.5 text-sm">
              <div className="flex justify-between text-xs">
                <span className="text-txt-dim">Lease</span>
                <span className={health.services.dhcp.has_lease ? "text-mint-safe" : "text-amber-base"}>
                  {health.services.dhcp.has_lease ? "ACTIVE" : "NONE"}
                </span>
              </div>
              <div className="text-xs text-txt-dim">{health.services.dhcp.detail}</div>
            </div>
          </Tile>

          {/* Subnet info */}
          {subnet && (
            <Tile title="SUBNET" led="cyan">
              <div className="space-y-0.5 text-sm">
                <div className="text-violet-bright font-mono text-base">{subnet.network}/{subnet.prefix}</div>
                <div className="flex justify-between text-xs">
                  <span className="text-txt-dim">Netmask</span>
                  <span className="text-txt-body font-mono">{subnet.netmask}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-txt-dim">Hosts</span>
                  <span className="text-amber-base">{subnet.usable_hosts.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-txt-dim">Range</span>
                  <span className="text-txt-body font-mono text-[0.65rem]">
                    {subnet.first_host}–{subnet.last_host}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-txt-dim">Broadcast</span>
                  <span className="text-txt-body font-mono">{subnet.broadcast}</span>
                </div>
              </div>
            </Tile>
          )}
        </div>
      )}

      {/* Device inventory — the meat */}
      {scanResult && hosts.length > 0 && (
        <Tile title={`DISCOVERED DEVICES (${hosts.length})`} led="cyan" padded={false}>
          <div className="overflow-auto max-h-[600px]">
            <table className="w-full text-[0.8125rem]">
              <thead className="sticky top-0 bg-bg-strip border-b border-line-dim">
                <tr>
                  <th className="px-3 py-2 text-left hud-label">IP</th>
                  <th className="px-3 py-2 text-left hud-label">MAC</th>
                  <th className="px-3 py-2 text-left hud-label">Vendor</th>
                  <th className="px-3 py-2 text-left hud-label">Type</th>
                  <th className="px-3 py-2 text-left hud-label">Host</th>
                  <th className="px-3 py-2 text-left hud-label">Ports</th>
                  <th className="px-3 py-2 text-left hud-label"></th>
                </tr>
              </thead>
              <tbody>
                {[...hosts].sort((a, b) => {
                  const ta = classifyDevice(a, gateway_ip);
                  const tb = classifyDevice(b, gateway_ip);
                  const oa = order.indexOf(ta);
                  const ob = order.indexOf(tb);
                  if (oa !== ob) return oa - ob;
                  return a.ip.localeCompare(b.ip, undefined, { numeric: true });
                }).map((h) => {
                  const dt = classifyDevice(h, gateway_ip);
                  const openPorts = h.ports.filter(p => p.state === "open");
                  const isSelected = selectedHost?.ip === h.ip;
                  return (
                    <Fragment key={h.ip}>
                      <tr
                        key={h.ip}
                        className={`border-b border-line-dim/40 cursor-pointer transition-colors ${isSelected ? "bg-cyan-signal/5" : "hover:bg-bg-strip/50"}`}
                        onClick={() => setSelectedHost(h)}
                      >
                        <td className="px-3 py-1.5 text-violet-bright font-mono">{h.ip}</td>
                        <td className="px-3 py-1.5 text-txt-dim font-mono text-xs">{h.mac || "—"}</td>
                        <td className="px-3 py-1.5 text-txt-body text-xs max-w-[200px] truncate" title={h.vendor}>{h.vendor || "—"}</td>
                        <td className="px-3 py-1.5">
                          <span className={`${TYPE_COLOR[dt]} text-xs font-bold`}>
                            {dt}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-txt-dim text-xs">{h.hostname || "—"}</td>
                        <td className="px-3 py-1.5">
                          {openPorts.length > 0 ? (
                            <span className="text-mint-safe text-xs font-mono">
                              {openPorts.map(p => p.port).join(", ")}
                            </span>
                          ) : (
                            <span className="text-txt-dim text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          <button
                            className="hud-btn text-xs px-2 py-0.5"
                            onClick={(e) => { e.stopPropagation(); scanHost(h.ip); }}
                            disabled={scanning === h.ip}
                          >
                            {scanning === h.ip ? "⟳" : "🔍 Scan"}
                          </button>
                        </td>
                      </tr>
                      {/* Expanded detail row */}
                      {isSelected && hostPorts && (
                        <tr key={`${h.ip}-detail`} className="bg-bg-base/50">
                          <td colSpan={7} className="px-6 py-3">
                            <div className="space-y-2">
                              <div className="flex items-center gap-4">
                                <span className="text-violet-bright font-bold">{h.ip}</span>
                                <span className={`${TYPE_COLOR[classifyDevice(h, gateway_ip)]} text-xs font-bold`}>
                                  {classifyDevice(h, gateway_ip)}
                                </span>
                                <span className="text-txt-dim text-xs font-mono">{h.mac}</span>
                                <span className="text-txt-body text-xs">{h.vendor}</span>
                              </div>
                              {h.ports.length > 0 ? (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-line-dim">
                                      <th className="px-2 py-1 text-left hud-label">Port</th>
                                      <th className="px-2 py-1 text-left hud-label">Proto</th>
                                      <th className="px-2 py-1 text-left hud-label">State</th>
                                      <th className="px-2 py-1 text-left hud-label">Service</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {h.ports
                                      .filter(p => p.state === "open")
                                      .map((p, i) => (
                                        <tr key={i} className="border-b border-line-dim/20">
                                          <td className="px-2 py-1 text-cyan-signal font-mono">{p.port}</td>
                                          <td className="px-2 py-1 text-txt-dim">{p.proto}</td>
                                          <td className="px-2 py-1 text-mint-safe">{p.state}</td>
                                          <td className="px-2 py-1 text-amber-base">{p.service}</td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              ) : (
                                <span className="text-txt-dim text-xs">No ports scanned yet — click Scan to nmap this host</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Tile>
      )}

      {/* Empty state */}
      {!scanResult && !busy && (
        <Tile title="READY" led="dim">
          <div className="text-center py-8 space-y-2">
            <div className="text-txt-dim text-lg">Network Tools Ready</div>
            <div className="text-txt-dim text-sm">
              Click <span className="text-cyan-signal font-bold">⚡ Discover Network</span> to run a full
              assessment of the connected network — link health, switch identification, gateway/DNS/DHCP,
              and a complete ARP sweep of all hosts with device classification.
            </div>
          </div>
        </Tile>
      )}
    </div>
  );
}
