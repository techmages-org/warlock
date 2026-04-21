import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";

type StubStatus = {
  module: string;
  label: string;
  status: string;
  requires_engagement: boolean;
  todo: string[];
};

export function Stub({ moduleId }: { moduleId: string }) {
  const [s, setStatus] = useState<StubStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<StubStatus>(`/api/${moduleId}/status`)
      .then(setStatus)
      .catch((e) => setErr(String(e)));
  }, [moduleId]);

  return (
    <div className="wl-card">
      <h1 className="text-lg font-bold mb-2">
        {s?.label ?? moduleId} {s?.requires_engagement && <span className="wl-badge bg-warlock-danger text-white ml-2">ENGAGEMENT-GATED</span>}
      </h1>
      {err ? (
        <div className="text-warlock-danger">error: {err}</div>
      ) : !s ? (
        <div className="text-warlock-muted">loading…</div>
      ) : (
        <>
          <div className="text-warlock-muted mb-4">
            Implementation pending — see roadmap in <code>02-warlock-command-center.md</code>.
          </div>
          <ul className="list-disc list-inside space-y-1">
            {s.todo.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
