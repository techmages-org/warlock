import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import clsx from "clsx";
import { EngagementBanner, HudBarBottom, HudBarTop } from "./components/hud";
import { apiGet, type ModuleInfo } from "./lib/api";
import { Audio } from "./pages/Audio";
import { Audit } from "./pages/Audit";
import { Blue } from "./pages/Blue";
import { Crack } from "./pages/Crack";
import { Dashboard } from "./pages/Dashboard";
import { Esp32Companion } from "./pages/Esp32Companion";
import { Gps } from "./pages/Gps";
import { Loot } from "./pages/Loot";
import { Mesh } from "./pages/Mesh";
import { NetRecon } from "./pages/NetRecon";
import { NetworkTools } from "./pages/NetworkTools";
import { Ops } from "./pages/Ops";
import { Reports } from "./pages/Reports";
import { Sdr } from "./pages/Sdr";
import { SdrOffensive } from "./pages/SdrOffensive";
import { Stub } from "./pages/Stub";
import { System } from "./pages/System";
import { WifiAnalyzer } from "./pages/WifiAnalyzer";
import { WifiRecon } from "./pages/WifiRecon";
import { Wireless } from "./pages/Wireless";

// Modules still rendered via the fallback StubPanel (no dedicated page yet).
const STUBBED = [
  "wifi_offensive",
];

/* ---------- nav grouping ---------- */

type NavEntry = { id: string; label: string; icon: string; to: string; requires_engagement?: boolean };
type NavGroup = { id: string; label: string; icon: string; entries: NavEntry[] };

// Static category mapping — module id → group id.
const MODULE_GROUP: Record<string, string> = {
  wifi_recon: "recon",
  wifi_analyzer: "recon",
  gps: "recon",
  mesh: "recon",
  sdr: "recon",

  // "Wireless" is a frontend-only guided flow, not in /api/modules.
  wireless: "attack",
  wifi_offensive: "attack",
  sdr_offensive: "attack",
  crack: "attack",
  capture: "attack",
  esp32_companion: "attack",

  wireless_ids: "defend",
  server_audit: "defend",

  netdiag: "tools",
  nettools: "tools",
  voip: "tools",
  net_recon: "tools",

  loot: "intel",
  reports: "intel",
  report: "intel",

  ops: "system",
  system: "system",
  audio: "system",
};

const GROUP_META: { id: string; label: string; icon: string }[] = [
  { id: "recon", label: "Recon", icon: "📡" },
  { id: "attack", label: "Attack", icon: "⚔" },
  { id: "defend", label: "Defend", icon: "🛡" },
  { id: "tools", label: "Tools", icon: "🔧" },
  { id: "intel", label: "Intel", icon: "📊" },
  { id: "system", label: "System", icon: "⚙" },
];

/* ---------- dropdown group component ---------- */

function GroupDropdown({
  group,
  entries,
  isActive,
}: {
  group: { id: string; label: string; icon: string };
  entries: NavEntry[];
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // Close on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "hud-btn whitespace-nowrap flex items-center gap-1.5",
          isActive && "border-violet-base text-violet-bright shadow-glow-violet",
          open && "border-violet-base",
        )}
      >
        <span aria-hidden="true">{group.icon}</span>
        <span>{group.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-50">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded border border-border-dim bg-bg-base shadow-2xl py-1">
          {entries.map((entry) => {
            const active = location.pathname === entry.to || location.pathname === entry.to.replace(/_/g, "-");
            return (
              <NavLink
                key={entry.id}
                to={entry.to}
                className={clsx(
                  "flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-active/40 transition-colors",
                  active ? "text-violet-bright" : "text-txt-main",
                )}
              >
                <span aria-hidden="true" className="text-violet-base w-5 text-center">{entry.icon}</span>
                <span className="flex-1">{entry.label}</span>
                {entry.requires_engagement && (
                  <span className="text-pink-alert text-xs" aria-label="engagement gated">!</span>
                )}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- main nav rail ---------- */

function ModuleRail() {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const location = useLocation();

  useEffect(() => {
    apiGet<ModuleInfo[]>("/api/modules")
      .then(setModules)
      .catch(() => setModules([]));
  }, []);

  // Build entries from API modules
  const moduleEntries: NavEntry[] = modules.map((m) => ({
    id: m.id,
    label: m.label,
    icon: m.icon,
    to: `/${m.id}`,
    requires_engagement: m.requires_engagement,
  }));

  // Add the frontend-only Wireless guided flow to Attack
  moduleEntries.unshift({
    id: "wireless",
    label: "Wireless",
    icon: "⌖",
    to: "/wireless",
  });

  // Group entries
  const grouped: Record<string, NavEntry[]> = {};
  for (const entry of moduleEntries) {
    const gid = MODULE_GROUP[entry.id];
    if (!gid) continue; // dashboard handled separately
    if (!grouped[gid]) grouped[gid] = [];
    grouped[gid].push(entry);
  }

  // Which group contains the current route?
  const currentPath = location.pathname.replace(/-/g, "_").slice(1);
  const activeGroup = MODULE_GROUP[currentPath] || (location.pathname === "/wireless" ? "attack" : "");

  return (
    <nav
      aria-label="module navigation"
      className="sticky top-6 z-20 flex h-10 items-center gap-1 overflow-visible border-b border-line-dim bg-bg-strip/90 px-3 backdrop-blur-sm"
    >
      {/* Dashboard — always pinned */}
      <NavLink
        to="/dashboard"
        className={({ isActive }) =>
          clsx(
            "hud-btn whitespace-nowrap",
            isActive && "border-violet-base text-violet-bright shadow-glow-violet",
          )
        }
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-violet-base">●</span>
          <span>Dashboard</span>
        </span>
      </NavLink>

      {/* Grouped dropdowns */}
      {GROUP_META.map((g) => {
        const entries = grouped[g.id] || [];
        if (entries.length === 0) return null;
        return (
          <GroupDropdown
            key={g.id}
            group={g}
            entries={entries}
            isActive={activeGroup === g.id}
          />
        );
      })}
    </nav>
  );
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <HudBarTop />
      <EngagementBanner />
      <ModuleRail />
      <main className="flex-1 px-4 py-4">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/mesh" element={<Mesh />} />
          <Route path="/gps" element={<Gps />} />
          <Route path="/loot" element={<Loot />} />
          <Route path="/ops" element={<Ops />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/report" element={<Reports />} />
          <Route path="/wifi_recon" element={<WifiRecon />} />
          <Route path="/wifi-recon" element={<WifiRecon />} />
          <Route path="/wifi_analyzer" element={<WifiAnalyzer />} />
          <Route path="/wifi-analyzer" element={<WifiAnalyzer />} />
          <Route path="/wireless" element={<Wireless />} />
          <Route path="/crack" element={<Crack />} />
          <Route path="/esp32_companion" element={<Esp32Companion />} />
          <Route path="/esp32-companion" element={<Esp32Companion />} />
          <Route path="/sdr" element={<Sdr />} />
          <Route path="/sdr_offensive" element={<SdrOffensive />} />
          <Route path="/sdr-offensive" element={<SdrOffensive />} />
          <Route path="/net_recon" element={<NetworkTools />} />
          <Route path="/net-recon" element={<NetworkTools />} />
          <Route path="/netdiag" element={<NetworkTools />} />
          <Route path="/nettools" element={<NetworkTools />} />
          <Route path="/voip" element={<NetworkTools />} />
          <Route path="/wireless_ids" element={<Blue />} />
          <Route path="/blue" element={<Blue />} />
          <Route path="/server_audit" element={<Audit />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/audio" element={<Audio />} />
          <Route path="/system" element={<System />} />
          {STUBBED.map((mid) => (
            <Route key={mid} path={`/${mid}`} element={<Stub moduleId={mid} />} />
          ))}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
      <HudBarBottom />
    </div>
  );
}
