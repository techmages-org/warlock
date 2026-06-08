// Screen registry barrel — maps module id → screen component.
//
// THIS FILE IS OWNED BY W0 AND ALREADY IMPORTS ALL 16 SCREENS. Downstream
// workers (W1–W4) do NOT edit it: they only replace their own
// `src/screens/<id>.tsx` shim with a real screen that keeps the exported name
// `Screen`. Because the import is by id and the export name is fixed, four
// workers can land in parallel with zero merge conflicts on this file.

import type { ComponentType } from "react";

import { Screen as Dashboard } from "./dashboard.js";
import { Screen as Agent } from "./agent.js";
import { Screen as Wireless } from "./wireless.js";
import { Screen as WifiRecon } from "./wifi_recon.js";
import { Screen as WifiAnalyzer } from "./wifi_analyzer.js";
import { Screen as WifiOffensive } from "./wifi_offensive.js";
import { Screen as Crack } from "./crack.js";
import { Screen as WirelessIds } from "./wireless_ids.js";
import { Screen as NetRecon } from "./net_recon.js";
import { Screen as ServerAudit } from "./server_audit.js";
import { Screen as Sdr } from "./sdr.js";
import { Screen as SdrOffensive } from "./sdr_offensive.js";
import { Screen as Gps } from "./gps.js";
import { Screen as Mesh } from "./mesh.js";
import { Screen as Ops } from "./ops.js";
import { Screen as System } from "./system.js";
import { Screen as Audio } from "./audio.js";
import { Screen as Esp32Companion } from "./esp32_companion.js";

import { UnderConstruction } from "../components/UnderConstruction.js";

export type ScreenComponent = ComponentType;

export const SCREENS: Record<string, ScreenComponent> = {
  dashboard: Dashboard,
  agent: Agent,
  wireless: Wireless,
  wifi_recon: WifiRecon,
  wifi_analyzer: WifiAnalyzer,
  wifi_offensive: WifiOffensive,
  crack: Crack,
  wireless_ids: WirelessIds,
  net_recon: NetRecon,
  server_audit: ServerAudit,
  sdr: Sdr,
  sdr_offensive: SdrOffensive,
  gps: Gps,
  mesh: Mesh,
  ops: Ops,
  system: System,
  audio: Audio,
  esp32_companion: Esp32Companion,
};

// Resolve a module id to its screen, falling back to an UNDER CONSTRUCTION box
// for any unknown id (e.g. a new backend module not yet given a screen).
export function getScreen(id: string): ScreenComponent {
  return SCREENS[id] ?? (() => <UnderConstruction label={id} />);
}
