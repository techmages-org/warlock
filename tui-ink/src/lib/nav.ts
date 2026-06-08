// Nav key-binding map — single source of truth for the g+<key> hotkeys, shared
// by the Nav rail, the help overlay, the bottom HUD legend, and the chord
// handler in app.tsx. Keys are the canonical bindings from the Textual TUI
// (src/warlock/tui/app.py BINDINGS), plus the three the web adds.
//
// `wireless` is a frontend-only guided flow (no backend /api/modules entry) —
// it is PINNED first in the nav, exactly like the web App.tsx. Textual had no
// binding for it; we assign `g f` ("flow") and surface it in help + legend.

export type NavKey = { id: string; key: string };

// id → second key of the `g <key>` chord.
export const NAV_KEYS: Record<string, string> = {
  dashboard: "d",
  agent: "b", // pinned AI assistant ("bot"); frontend-only, not a backend module
  wireless: "f", // pinned guided flow (W0-assigned; not in Textual)
  wifi_recon: "w",
  wifi_analyzer: "z", // analyZer — Channels/Survey/Locate (g z)
  wifi_offensive: "o",
  crack: "c",
  wireless_ids: "i",
  net_recon: "n",
  server_audit: "a",
  sdr: "s",
  sdr_offensive: "x",
  gps: "g",
  mesh: "m",
  ops: "e",
  system: "h",
  audio: "u",
  esp32_companion: "p",
};

// The pinned, frontend-only Wireless flow entry (mirrors web App.tsx).
export const PINNED_WIRELESS = {
  id: "wireless",
  label: "Wireless",
  icon: "⌖",
  requires_engagement: false,
  requires_root: false,
};

// The pinned, frontend-only AI assistant entry (no /api/modules backing).
export const PINNED_AGENT = {
  id: "agent",
  label: "Assistant",
  icon: "✦",
  requires_engagement: false,
  requires_root: false,
};

// Reverse lookup: second-key → module id (for the chord handler).
export const KEY_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(NAV_KEYS).map(([id, key]) => [key, id]),
);

export function keyFor(id: string): string | undefined {
  return NAV_KEYS[id];
}
