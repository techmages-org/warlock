import type { ReactNode } from "react";

export function ModuleHeader({
  title,
  code,
  state,
  icon,
  right,
  version = "v0.1",
}: {
  title: string;
  code: string;
  state: string;
  icon?: ReactNode;
  right?: ReactNode;
  version?: string;
}) {
  return (
    <div className="mb-4 border-b border-line-dim pb-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[0.75rem] uppercase tracking-label text-violet-bright">
          {icon && (
            <span aria-hidden="true" className="text-violet-base">
              {icon}
            </span>
          )}
          <span className="text-txt-dim">MOD //</span>
          <span>{code}</span>
          <span className="text-txt-dim">{version}</span>
          <span className="text-txt-dim">::</span>
          <span className="text-amber-base" style={{ textShadow: "var(--glow-amber)" }}>
            {state}
          </span>
        </div>
        {right && <div>{right}</div>}
      </div>
      <h1 className="mt-1.5 text-[1.375rem] font-semibold tracking-tight text-txt-hi">{title}</h1>
    </div>
  );
}
