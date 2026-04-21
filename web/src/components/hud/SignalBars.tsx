import clsx from "clsx";

// Discrete segmented signal display rendered with styled divs (not unicode).
// Used for SNR, RSSI, link quality readouts.

type Color = "mint" | "amber" | "cyan" | "pink" | "violet";
const FILL_CLASS: Record<Color, string> = {
  mint: "bg-mint-safe",
  amber: "bg-amber-base",
  cyan: "bg-cyan-signal",
  pink: "bg-pink-alert",
  violet: "bg-violet-base",
};
const GLOW: Record<Color, string> = {
  mint: "var(--glow-mint)",
  amber: "var(--glow-amber)",
  cyan: "0 0 6px rgba(0,229,255,0.45)",
  pink: "var(--glow-pink)",
  violet: "var(--glow-violet)",
};

export function SignalBars({
  value,
  min = 0,
  max = 10,
  bars = 6,
  color = "cyan",
  label,
  className,
}: {
  value: number | null | undefined;
  min?: number;
  max?: number;
  bars?: number;
  color?: Color;
  label?: string;
  className?: string;
}) {
  const raw = value == null ? 0 : value;
  const clamped = Math.max(min, Math.min(max, raw));
  const ratio = max === min ? 0 : (clamped - min) / (max - min);
  const filled = Math.round(ratio * bars);

  return (
    <span
      role="meter"
      aria-valuenow={value ?? undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label ?? `signal ${value ?? "n/a"}`}
      className={clsx("inline-flex items-end gap-[2px]", className)}
    >
      {Array.from({ length: bars }).map((_, i) => {
        const h = 4 + i * 2; // 4px, 6px, 8px, ...
        const active = i < filled;
        return (
          <span
            key={i}
            className={clsx(
              "inline-block w-[3px] border border-line-dim",
              active ? FILL_CLASS[color] : "bg-transparent",
            )}
            style={{
              height: h,
              boxShadow: active ? GLOW[color] : undefined,
              borderColor: active ? "transparent" : "var(--line-dim)",
            }}
          />
        );
      })}
    </span>
  );
}
