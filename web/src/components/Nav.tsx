import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { apiGet, type ModuleInfo } from "../lib/api";
import clsx from "clsx";

export function Nav() {
  const [modules, setModules] = useState<ModuleInfo[]>([]);

  useEffect(() => {
    apiGet<ModuleInfo[]>("/api/modules")
      .then(setModules)
      .catch(() => setModules([]));
  }, []);

  return (
    <nav className="flex flex-wrap gap-1 px-4 py-2 border-b border-warlock-border bg-warlock-panel/60">
      {modules.map((m) => (
        <NavLink
          key={m.id}
          to={`/${m.id}`}
          className={({ isActive }) =>
            clsx(
              "wl-btn",
              isActive && "border-warlock-accent text-warlock-accent",
              m.requires_engagement && "italic",
            )
          }
          title={m.requires_engagement ? "Engagement-gated" : undefined}
        >
          <span className="mr-1">{m.icon}</span>
          {m.label}
          {m.requires_engagement && <span className="ml-1 text-warlock-warn">!</span>}
        </NavLink>
      ))}
    </nav>
  );
}
