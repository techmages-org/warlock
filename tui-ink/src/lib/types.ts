// Shared API types — ported field-for-field from the web client
// (web/src/lib/api.ts) so the Ink TUI and the web HUD speak the same shapes
// against the same FastAPI backend. Downstream workers (W1–W4) import from here.

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

export type Version = {
  name: string;
  version: string;
};

// Result of POST /api/engagements/killswitch.
export type KillswitchResult = {
  cancelled_jobs: number;
  interfaces_restored: number;
};

// WS event-bus frame (mirrors web lib/ws.ts WireEvent).
export type WireEvent = {
  name: string;
  payload: Record<string, unknown>;
  ts: string;
};

// ADS-B aircraft row — the FULL readsb intel set per the ORCHESTRATION.md
// "ADS-B aircraft field contract". W3's `sdr` screen reuses this verbatim.
// All fields optional: readsb omits anything it hasn't decoded yet.
export type Aircraft = {
  // identity
  icao?: string; // hex
  callsign?: string; // flight
  registration?: string; // r
  type?: string; // t
  type_desc?: string; // desc
  operator?: string; // ownOp
  db_flags?: number; // dbFlags bitfield: 1=mil,2=interesting,4=PIA,8=LADD
  category?: string;
  // kinematics
  altitude_ft?: number; // alt_baro
  alt_geom_ft?: number; // alt_geom (WGS84)
  speed_kt?: number; // gs
  ias?: number;
  tas?: number;
  mach?: number;
  heading?: number; // track
  mag_heading?: number;
  true_heading?: number;
  vert_rate_fpm?: number; // baro_rate
  geom_rate?: number;
  roll?: number;
  track_rate?: number;
  // transponder / nav
  squawk?: string;
  emergency?: string;
  sel_altitude_ft?: number; // nav_altitude_mcp
  sel_heading?: number; // nav_heading
  nav_qnh?: number;
  nav_modes?: string[];
  // position
  lat?: number;
  lon?: number;
  nic?: number;
  rc?: number;
  nac_p?: number;
  nac_v?: number;
  sil?: number;
  sil_type?: string;
  // link quality
  messages?: number;
  seen_s?: number; // seen
  seen_pos_s?: number; // seen_pos
  rssi?: number;
  // derived weather (may be absent)
  wind_dir?: number; // wd
  wind_speed?: number; // ws
  oat?: number;
  tat?: number;
  // computed screen-side from lat/lon vs receiver (Granger 30.7188,-97.4436):
  distance_nm?: number;
  bearing_deg?: number;
};
