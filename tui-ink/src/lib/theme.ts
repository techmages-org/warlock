// HUD colour theme → Ink/chalk hex strings. Mirrors the web CSS custom
// properties (--amber-base, --violet-base, …) so the TUI reads like the web
// HUD. Ink renders hex via chalk truecolor; terminals that lack truecolor
// degrade to the nearest ANSI colour automatically.

export type LEDColor = "amber" | "violet" | "mint" | "cyan" | "pink" | "dim";

export const COLORS: Record<LEDColor, string> = {
  amber: "#ffb000",
  violet: "#a78bfa",
  mint: "#34d399",
  cyan: "#00e5ff",
  pink: "#ff2975",
  dim: "#6b7280",
};

// Neutral text tiers (web --txt-hi / --txt-body / --txt-dim).
export const TEXT = {
  hi: "#e5e7eb",
  body: "#cbd5e1",
  dim: "#6b7280",
};

export function ledColor(c: LEDColor): string {
  return COLORS[c];
}

// Severity → LED, matching the web Dashboard's severityLed().
export type Severity = "ok" | "warn" | "err" | "dim";
export function severityLed(sev: Severity): LEDColor {
  switch (sev) {
    case "ok":
      return "mint";
    case "warn":
      return "amber";
    case "err":
      return "pink";
    case "dim":
      return "dim";
  }
}
