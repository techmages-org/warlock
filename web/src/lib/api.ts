// Minimal API client. All endpoints are same-origin when served from FastAPI,
// or proxied through Vite in dev.

export async function apiGet<T = any>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  return (await r.json()) as T;
}

export async function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  return (await r.json()) as T;
}

export type EngagementStatus = {
  mode: "on" | "off" | "loading";
  engagement_id: string | null;
  name: string;
  scope: { ssids: string[]; bssids: string[]; ip_ranges: string[] };
  started_at: string | null;
};

export type ModuleInfo = {
  id: string;
  label: string;
  icon: string;
  requires_engagement: boolean;
  requires_root: boolean;
};

export type DashboardStatus = {
  hostname: string;
  now: string;
  cpu: { load_1m: number; load_5m: number; load_15m: number; percent: number; count: number };
  memory: { total_mb: number; available_mb: number; percent: number };
  temp_c: number | null;
  temp_f: number | null;
  throttled: string | null;
  disk_root_mb_free: number;
  disk_root_percent: number;
  rtc_drift_s: number | null;
  chrony: { ok: boolean; stratum?: number; offset_s?: number; source?: string; reason?: string };
  gps: { ok: boolean; mode?: number; lat?: number; lon?: number; alt?: number; reason?: string };
  nmcli_active: Array<{ name: string; device: string; state: string; type: string }>;
  mesh_node_count: number | null;
  sdr: { ok: boolean; count?: number; reason?: string };
  engagement: EngagementStatus;
};

export type MeshNode = {
  id: string;
  num?: number;
  long_name?: string;
  short_name?: string;
  hw?: string;
  last_heard?: number;
  snr?: number;
  hops_away?: number;
  battery_pct?: number;
  lat?: number;
  lon?: number;
  alt?: number;
};
