import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { EngagementBanner, HudBarBottom, HudBarTop } from "./components/hud";
import { apiGet, type ModuleInfo } from "./lib/api";
import { Dashboard } from "./pages/Dashboard";
import { Gps } from "./pages/Gps";
import { Mesh } from "./pages/Mesh";
import { NetRecon } from "./pages/NetRecon";
import { Ops } from "./pages/Ops";
import { Sdr } from "./pages/Sdr";
import { Stub } from "./pages/Stub";
import { System } from "./pages/System";
import { WifiRecon } from "./pages/WifiRecon";

// Modules still rendered via the fallback StubPanel (no dedicated page yet).
const STUBBED = [
  "wifi_offensive",
  "sdr_offensive",
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
          <Route path="/sdr" element={<Sdr />} />
          <Route path="/net_recon" element={<NetRecon />} />
          <Route path="/net-recon" element={<NetRecon />} />
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
