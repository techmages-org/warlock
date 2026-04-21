import clsx from "clsx";
import type { ReactNode } from "react";
import { FrameCorners } from "./FrameCorners";
import { StatusLED, type LEDColor } from "./StatusLED";

export function Tile({
  title,
  icon,
  led,
  headerRight,
  children,
  className,
  padded = true,
  cornerColor,
}: {
  title?: string;
  icon?: ReactNode;
  led?: LEDColor;
  headerRight?: ReactNode;
  children?: ReactNode;
  className?: string;
  padded?: boolean;
  cornerColor?: string;
}) {
  return (
    <section
      className={clsx(
        "hud-tile relative flex flex-col",
        // Tiles are flat rectangles — no rounding. The corner brackets carry
        // the visual interest instead.
        className,
      )}
    >
      <FrameCorners color={cornerColor} />
      {(title || led || headerRight) && (
        <header className="relative flex items-center justify-between border-b border-line-dim px-4 py-2">
          <div className="flex items-center gap-2">
            {icon && (
              <span aria-hidden="true" className="text-violet-bright">
                {icon}
              </span>
            )}
            {title && <span className="hud-label">{title}</span>}
          </div>
          <div className="flex items-center gap-2">
            {headerRight}
            {led && <StatusLED color={led} label={`${title ?? ""} status`} />}
          </div>
        </header>
      )}
      <div className={clsx("relative flex-1", padded && "px-4 py-4")}>{children}</div>
    </section>
  );
}
