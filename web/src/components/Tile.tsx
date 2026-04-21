import clsx from "clsx";

type Severity = "ok" | "warn" | "err";

export function Tile({
  title,
  value,
  subtitle,
  severity = "ok",
}: {
  title: string;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  severity?: Severity;
}) {
  return (
    <div
      className={clsx(
        "wl-card min-h-[6rem] flex flex-col justify-between",
        severity === "warn" && "border-warlock-warn",
        severity === "err" && "border-warlock-danger",
      )}
    >
      <div className="text-xs uppercase tracking-wider text-warlock-muted">{title}</div>
      <div
        className={clsx(
          "text-xl font-bold",
          severity === "warn" && "text-warlock-warn",
          severity === "err" && "text-warlock-danger",
          severity === "ok" && "text-warlock-accent",
        )}
      >
        {value}
      </div>
      {subtitle && <div className="text-xs text-warlock-muted truncate">{subtitle}</div>}
    </div>
  );
}
