import type { ReactNode } from "react";
import { FrameCorners } from "./FrameCorners";
import { StatusLED } from "./StatusLED";
import { ModuleHeader } from "./ModuleHeader";

// Offline / "powered-off instrument" panel. Used for modules that have been
// stubbed in the backend — we render their planned roadmap so the UI conveys
// "this panel exists, it's just not energised yet" instead of a plain text
// pending message.

export function StubPanel({
  codename,
  title,
  icon,
  wave = 1,
  todo,
  requiresEngagement = false,
  footerNote,
}: {
  codename: string;
  title: string;
  icon?: ReactNode;
  wave?: number;
  todo?: string[];
  requiresEngagement?: boolean;
  footerNote?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ModuleHeader
        code={codename}
        title={title}
        state="STANDBY"
        icon={icon}
        right={
          requiresEngagement ? (
            <span className="hud-label text-pink-alert">ENGAGEMENT-GATED</span>
          ) : undefined
        }
      />

      {/* Instrument face — the big standby display. */}
      <section className="hud-tile relative min-h-[260px]">
        <FrameCorners color="var(--violet-deep)" />
        <div className="relative flex flex-col items-center justify-center gap-6 px-6 py-10">
          <div
            aria-hidden="true"
            className="flex h-16 w-16 items-center justify-center rounded-full border border-line-mid text-[2.25rem] text-violet-deep/70"
            style={{ boxShadow: "inset 0 0 24px rgba(124,58,237,0.25)" }}
          >
            {icon ?? "◌"}
          </div>
          <div className="flex items-center gap-3">
            <StatusLED color="dim" size={10} label="powered off" />
            <span className="text-[1.125rem] font-semibold uppercase tracking-label text-txt-dim">
              STANDBY
            </span>
          </div>
          <div className="text-center text-[0.8125rem] text-txt-dim">
            <div className="uppercase tracking-label text-violet-bright/70">{codename}</div>
            <div className="mt-1">instrument unpowered — awaiting implementation</div>
          </div>
        </div>
      </section>

      {/* Roadmap panel */}
      <section className="hud-tile relative">
        <FrameCorners />
        <header className="flex items-center justify-between border-b border-line-dim px-4 py-2">
          <span className="hud-label">PLANNED CAPABILITIES // ROADMAP</span>
          <span className="hud-label text-txt-dim">wave {wave}</span>
        </header>
        <div className="px-4 py-3">
          {todo && todo.length > 0 ? (
            <ul className="space-y-1.5">
              {todo.map((item, i) => (
                <li key={i} className="flex items-start gap-3 text-txt-body">
                  <span
                    aria-hidden="true"
                    className="mt-[6px] inline-block h-1.5 w-1.5 flex-shrink-0 bg-violet-deep"
                    style={{ boxShadow: "var(--glow-violet)" }}
                  />
                  <span className="flex-1">{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-txt-dim">no roadmap published yet</div>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-line-dim px-4 py-2 hud-label">
          <span className="text-txt-dim">
            [ DEPLOY ] — pending wave <span className="text-amber-base">{wave}</span>
          </span>
          <span className="text-txt-dim">{footerNote ?? "backend module stubbed"}</span>
        </footer>
      </section>
    </div>
  );
}
