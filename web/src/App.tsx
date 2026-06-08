import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { EngagementBanner, HudBarBottom, HudBarTop } from "./components/hud";
import { apiGet, type ModuleInfo } from "./lib/api";
import { Audio } from "./pages/Audio";
import { Audit } from "./pages/Audit";
import { Blue } from "./pages/Blue";
import { Crack } from "./pages/Crack";
import { Dashboard } from "./pages/Dashboard";
import { Gps } from "./pages/Gps";
import { Mesh } from "./pages/Mesh";
import { NetRecon } from "./pages/NetRecon";
import { Ops } from "./pages/Ops";
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
  "esp32_companion",
];

function ModuleRail() {
  const [modules, setModules] = useState<ModuleInfo[]>([]);

  useEffect(() => {
    apiGet<ModuleInfo[]>("/api/modules")
      .then(setModules)
      .catch(() => setModules([]));
  }, []);

  return (
    <nav
      aria-label="module navigation"
      className="sticky top-6 z-20 flex h-10 items-center gap-1 overflow-x-auto border-b border-line-dim bg-bg-strip/90 px-3 backdrop-blur-sm"
    >
      {/* Manual flagship entry — the guided "Wireless" flow is a frontend-only
          page (no backend module), so it isn't in /api/modules; pin it first,
          alongside the auto-generated module rail. */}
      <NavLink
        to="/wireless"
        title="Guided wireless flow — arm · recon · target · act · loot"
        className={({ isActive }) =>
          clsx(
            "hud-btn whitespace-nowrap",
            isActive && "border-violet-base text-violet-bright shadow-glow-violet",
          )
        }
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-amber-base">⌖</span>
          <span>Wireless</span>
        </span>
      </NavLink>

      {modules.map((m) => (
        <NavLink
          key={m.id}
          to={`/${m.id}`}
          title={m.requires_engagement ? "Engagement-gated" : undefined}
          className={({ isActive }) =>
            clsx(
              "hud-btn whitespace-nowrap",
              isActive && "border-violet-base text-violet-bright shadow-glow-violet",
            )
          }
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-violet-base">
              {m.icon}
            </span>
            <span>{m.label}</span>
            {m.requires_engagement && (
              <span className="text-pink-alert" aria-label="engagement gated">!</span>
            )}
          </span>
        </NavLink>
      ))}
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
          <Route path="/ops" element={<Ops />} />
          <Route path="/wifi_recon" element={<WifiRecon />} />
          <Route path="/wifi-recon" element={<WifiRecon />} />
          <Route path="/wifi_analyzer" element={<WifiAnalyzer />} />
          <Route path="/wifi-analyzer" element={<WifiAnalyzer />} />
          <Route path="/wireless" element={<Wireless />} />
          <Route path="/crack" element={<Crack />} />
          <Route path="/sdr" element={<Sdr />} />
          <Route path="/sdr_offensive" element={<SdrOffensive />} />
          <Route path="/sdr-offensive" element={<SdrOffensive />} />
          <Route path="/net_recon" element={<NetRecon />} />
          <Route path="/net-recon" element={<NetRecon />} />
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
