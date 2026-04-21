import clsx from "clsx";

export type LEDColor = "amber" | "violet" | "mint" | "cyan" | "pink" | "dim";

const COLOR_MAP: Record<LEDColor, { fill: string; glow: string }> = {
  amber:  { fill: "var(--amber-base)",   glow: "var(--glow-amber)" },
  violet: { fill: "var(--violet-base)",  glow: "var(--glow-violet)" },
  mint:   { fill: "var(--mint-safe)",    glow: "var(--glow-mint)" },
  cyan:   { fill: "var(--cyan-signal)",  glow: "0 0 8px rgba(0,229,255,0.5)" },
  pink:   { fill: "var(--pink-alert)",   glow: "var(--glow-pink)" },
  dim:    { fill: "var(--txt-dim)",      glow: "none" },
};

export function StatusLED({
  color,
  size = 8,
  label,
  className,
}: {
  color: LEDColor;
  size?: 6 | 7 | 8 | 10;
  label?: string;
  className?: string;
}) {
  const { fill, glow } = COLOR_MAP[color];
  const isLive = color !== "dim";
  return (
    <span
      role="img"
      aria-label={label ?? `status ${color}`}
      className={clsx(
        "inline-block rounded-full align-middle",
        isLive && "animate-pulse-live",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: fill,
        boxShadow: glow,
      }}
    />
  );
}
