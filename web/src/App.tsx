import { Navigate, Route, Routes } from "react-router-dom";
import { EngagementBanner } from "./components/EngagementBanner";
import { Nav } from "./components/Nav";
import { Dashboard } from "./pages/Dashboard";
import { Mesh } from "./pages/Mesh";
import { Stub } from "./pages/Stub";

const STUBBED = [
  "gps",
  "sdr",
  "wifi_recon",
  "wifi_offensive",
  "net_recon",
  "sdr_offensive",
  "esp32_companion",
  "ops",
  "system",
];

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <EngagementBanner />
      <Nav />
      <main className="flex-1 px-4 py-4">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/mesh" element={<Mesh />} />
          {STUBBED.map((mid) => (
            <Route key={mid} path={`/${mid}`} element={<Stub moduleId={mid} />} />
          ))}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
      <footer className="px-4 py-2 text-xs text-warlock-muted border-t border-warlock-border">
        warlock-command-center · uConsole field kit
      </footer>
    </div>
  );
}
