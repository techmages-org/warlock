import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { EngagementBanner, HudBarBottom, HudBarTop } from "./components/hud";
import { apiGet, type ModuleInfo } from "./lib/api";
import { Dashboard } from "./pages/Dashboard";
import { Gps } from "./pages/Gps";
import { Mesh } from "./pages/Mesh";
import { Stub } from "./pages/Stub";

const STUBBED = [
  "sdr",
  "wifi_recon",
  "wifi_offensive",
  "net_recon",
  "sdr_offensive",
  "esp32_companion",
  "ops",
  "system",
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
