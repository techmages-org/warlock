import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

type ValueColor = "amber" | "violet" | "mint" | "cyan" | "pink" | "dim";

const COLOR_CLASS: Record<ValueColor, string> = {
  amber: "text-amber-base",
  violet: "text-violet-bright",
  mint: "text-mint-safe",
  cyan: "text-cyan-signal",
  pink: "text-pink-alert",
  dim: "text-txt-dim",
};

const GLOW: Partial<Record<ValueColor, string>> = {
  amber: "var(--glow-amber)",
  violet: "var(--glow-violet)",
  mint: "var(--glow-mint)",
  pink: "var(--glow-pink)",
  cyan: "0 0 8px rgba(0,229,255,0.45)",
};

export function BigValue({
  value,
  unit,
  color = "amber",
  size = "lg",
  flashOnChange = false,
  className,
}: {
  value: string | number;
  unit?: string;
  color?: ValueColor;
  size?: "md" | "lg" | "xl";
  flashOnChange?: boolean;
  className?: string;
}) {
  const [flashKey, setFlashKey] = useState(0);
  const prev = useRef<string | number>(value);

  useEffect(() => {
    if (!flashOnChange) return;
    if (prev.current !== value) {
      prev.current = value;
      setFlashKey((k) => k + 1);
    }
  }, [value, flashOnChange]);

  const sizeClass =
    size === "xl" ? "text-[2.5rem] leading-none"
    : size === "lg" ? "text-[1.875rem] leading-none"
    : "text-[1.25rem] leading-none";

  return (
    <div
      key={flashKey}
      className={clsx(
        "inline-flex items-baseline gap-1.5 tabular-nums font-normal",
        flashOnChange && flashKey > 0 && "animate-value-flash",
        className,
      )}
    >
      <span
        className={clsx(sizeClass, COLOR_CLASS[color])}
        style={{ textShadow: GLOW[color], fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
      {unit && <span className="hud-label">{unit}</span>}
    </div>
  );
}
