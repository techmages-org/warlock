// Engagements / Ops — Ink TUI screen.
// Mirrors web/src/pages/Ops.tsx.
// Controls the global engagement mode that gates all offensive operations.
// Tabs: [1] ACTIVE (current engagement)  [2] NEW (create form)
//       [3] HISTORY (past engagements)   [4] AUDIT (command log)
// Keys: 1-4 switch tabs (disabled while in form), ↑↓ form field nav / list cursor,
//       e end engagement, k killswitch. Esc exits the NEW form.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import TextInput from "ink-text-input";
import { ModuleHeader } from "../components/ModuleHeader.js";
import { StatusLED } from "../components/StatusLED.js";
import { Tile } from "../components/Tile.js";
import { useApi } from "../context.js";
import { usePoll } from "../lib/hooks.js";
import { COLORS, TEXT, type LEDColor } from "../lib/theme.js";

// ── Types ────────────────────────────────────────────────────────────────────

type OpsStatus = {
  ok: boolean;
  mode: "on" | "off";
  engagement_id: string | null;
  name: string;
  scope: { ssids: string[]; bssids: string[]; ip_ranges: string[] };
  started_at: string | null;
  elapsed_s: number | null;
  auth_statement: string;
};

type EngagementRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  targets_count: number;
};

type EngagementList = {
  ok: boolean;
  engagements: EngagementRow[];
};

type AuditRow = {
  id: string;
  ts: string;
  engagement_id: string;
  kind: string;
  command: string;
  target: string | null;
  outcome: string | null;
};

type AuditList = {
  ok: boolean;
  audit: AuditRow[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtElapsed(s: number | null): string {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+$/, "");
}

type Tab = "active" | "new" | "history" | "audit";

// Tokens that must not be submitted as actual scope targets — they are the
// literal words from the old abstract placeholder and must never become real
// scope entries. Case-insensitive. The backend now rejects these too, but we
// catch client-side for a clean inline error.
const TARGETS_DENYLIST = new Set(["ssid", "bssid", "ip/cidr", "cidr"]);

/** Returns true when `raw` is blank or consists entirely of placeholder tokens. */
export function isBlockedTargets(raw: string): boolean {
  const tokens = raw.split(",").map(s => s.trim()).filter(Boolean);
  return tokens.length === 0 || tokens.every(t => TARGETS_DENYLIST.has(t.toLowerCase()));
}

// ── Screen ───────────────────────────────────────────────────────────────────

export function Screen() {
  const api = useApi();

  // Tab + list cursor (shared, resets on tab switch)
  const [tab, setTab] = useState<Tab>("active");
  const [cursor, setCursor] = useState(0);

  // Form state
  const [formName, setFormName] = useState("");
  const [formAuth, setFormAuth] = useState("");
  const [formTargets, setFormTargets] = useState("");
  const [formDuration, setFormDuration] = useState("4");
  const [formField, setFormField] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Action feedback
  const [tick, setTick] = useState(0);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Data
  const { data: opsStatus, error: statusError } = usePoll<OpsStatus>(
    () => api.get<OpsStatus>("/api/ops/status"),
    2000,
    [api, tick],
  );

  const { data: engList } = usePoll<EngagementList>(
    () => api.get<EngagementList>("/api/ops/engagements?limit=20"),
    10000,
    [api, tick],
  );

  const { data: auditList } = usePoll<AuditList>(
    () => api.get<AuditList>("/api/ops/audit?limit=30"),
    10000,
    [api, tick],
  );

  const engagements = engList?.engagements ?? [];
  const audits = auditList?.audit ?? [];
  const inForm = tab === "new";

  // Form submit handler
  const handleSubmit = () => {
    if (!formName.trim() || !formAuth.trim()) {
      setActionMsg("Name and authorization are required");
      return;
    }
    const targets = formTargets.split(",").map(s => s.trim()).filter(Boolean);
    if (
      targets.length === 0 ||
      targets.every(t => TARGETS_DENYLIST.has(t.toLowerCase()))
    ) {
      setActionMsg("enter real targets (SSID / BSSID / CIDR)");
      return;
    }
    const dur = parseFloat(formDuration) || 4.0;
    setSubmitting(true);
    void api
      .post("/api/ops/engagements", {
        name: formName.trim(),
        authorization: formAuth.trim(),
        targets,
        duration_hours: dur,
      })
      .then(() => {
        setTick(t => t + 1);
        setActionMsg("Engagement activated");
        setTab("active");
        setFormName(""); setFormAuth(""); setFormTargets(""); setFormDuration("4");
        setFormField(0);
      })
      .catch((e: unknown) => setActionMsg(`Error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setSubmitting(false));
  };

  useInput((input, key) => {
    // Tab switching — disabled while typing in form
    if (!inForm) {
      if (input === "1") { setTab("active"); setCursor(0); setActionMsg(null); return; }
      if (input === "2") { setTab("new"); setFormField(0); setActionMsg(null); return; }
      if (input === "3") { setTab("history"); setCursor(0); setActionMsg(null); return; }
      if (input === "4") { setTab("audit"); setCursor(0); setActionMsg(null); return; }
    }

    // Form navigation
    if (inForm) {
      if (key.escape) { setTab("active"); setFormField(0); setActionMsg(null); return; }
      if (key.downArrow) { setFormField(f => Math.min(3, f + 1)); return; }
      if (key.upArrow) { setFormField(f => Math.max(0, f - 1)); return; }
      return; // swallow other keys while in form (TextInput handles printable chars)
    }

    // Active tab actions
    if (tab === "active") {
      if (input === "e" && opsStatus?.mode === "on") {
        void api
          .post("/api/ops/engagements/end")
          .then(() => { setTick(t => t + 1); setActionMsg("Engagement ended"); })
          .catch((e: unknown) => setActionMsg(`Error: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (input === "k") {
        void api
          .post("/api/ops/killswitch")
          .then(() => { setTick(t => t + 1); setActionMsg("KILLSWITCH activated"); })
          .catch((e: unknown) => setActionMsg(`Error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // List cursor (history / audit)
    const listLen = tab === "history" ? engagements.length : tab === "audit" ? audits.length : 0;
    if (key.downArrow || input === "j") { setCursor(c => Math.min(Math.max(0, listLen - 1), c + 1)); }
    if (key.upArrow || input === "k") { setCursor(c => Math.max(0, c - 1)); }
  });

  // ── Header LED / state ───────────────────────────────────────────────────────
  const modeLed: LEDColor = opsStatus?.mode === "on" ? "pink" : "mint";
  const modeState = opsStatus ? (opsStatus.mode === "on" ? "ENGAGED" : "SAFE") : "ACQUIRING";

  // ── Error state ─────────────────────────────────────────────────────────────
  if (statusError) {
    return (
      <Box flexDirection="column">
        <ModuleHeader code="11 OPS" title="Engagements" state="LINK ERROR" icon="⚑" />
        <Tile title="ERROR" led="pink" width={60}>
          <Text color={COLORS.pink}>ops error: {statusError}</Text>
        </Tile>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <ModuleHeader
        code="11 OPS"
        title="Engagements"
        state={modeState}
        icon="⚑"
        right={
          opsStatus?.mode === "on" ? (
            <Text color={COLORS.pink}> ● {opsStatus.name}</Text>
          ) : undefined
        }
      />

      {/* Engagement status banner */}
      <Tile title="ENGAGEMENT STATUS" led={modeLed} width={116}>
        {!opsStatus ? (
          <Text color={TEXT.dim}>acquiring status…</Text>
        ) : opsStatus.mode === "on" ? (
          <Box>
            <StatusLED color="pink" />
            <Text color={COLORS.pink} bold>  ENGAGED  </Text>
            <Text color={TEXT.body}>{opsStatus.name}</Text>
            <Text color={TEXT.dim}>
              {" "}· elapsed: {fmtElapsed(opsStatus.elapsed_s)}
              {" "}· {opsStatus.scope.ssids.length}S/{opsStatus.scope.bssids.length}B/{opsStatus.scope.ip_ranges.length}IP
            </Text>
          </Box>
        ) : (
          <Box>
            <StatusLED color="mint" />
            <Text color={COLORS.mint} bold>  SAFE MODE  </Text>
            <Text color={TEXT.dim}>no active engagement — offensive actions are disabled</Text>
          </Box>
        )}
      </Tile>

      {/* Tab bar */}
      <Box>
        {(["active", "new", "history", "audit"] as Tab[]).map((t, i) => (
          <Text key={t} color={tab === t ? COLORS.amber : TEXT.dim} bold={tab === t}>
            {i > 0 ? "  │  " : " "}[{i + 1}]{" "}
            {t === "active" ? "ACTIVE" : t === "new" ? "NEW" : t === "history" ? "HISTORY" : "AUDIT"}
          </Text>
        ))}
        {inForm ? <Text color={TEXT.dim}>    Esc:cancel  ↑↓:fields</Text> : null}
      </Box>

      {/* ── ACTIVE TAB ────────────────────────────────────────────────────────── */}
      {tab === "active" && (
        <Tile title="ACTIVE ENGAGEMENT" led={modeLed} width={116}>
          {!opsStatus || opsStatus.mode === "off" ? (
            <Box flexDirection="column">
              <Text color={TEXT.dim}>No active engagement.</Text>
              <Text color={TEXT.dim}>Press [2] to create a new engagement.</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text color={TEXT.dim}>ID:      </Text>
                <Text color={TEXT.body}>{opsStatus.engagement_id ?? "—"}</Text>
              </Box>
              <Box>
                <Text color={TEXT.dim}>Name:    </Text>
                <Text color={COLORS.amber}>{opsStatus.name}</Text>
              </Box>
              <Box>
                <Text color={TEXT.dim}>Started: </Text>
                <Text color={TEXT.body}>{fmtTs(opsStatus.started_at)}</Text>
                <Text color={TEXT.dim}>  Elapsed: </Text>
                <Text color={COLORS.amber}>{fmtElapsed(opsStatus.elapsed_s)}</Text>
              </Box>
              <Box>
                <Text color={TEXT.dim}>Scope:   </Text>
                <Text color={TEXT.body}>
                  {opsStatus.scope.ssids.length}S/{opsStatus.scope.bssids.length}B/{opsStatus.scope.ip_ranges.length}IP
                </Text>
              </Box>
              {opsStatus.auth_statement ? (
                <Box>
                  <Text color={TEXT.dim}>Auth:    </Text>
                  <Text color={TEXT.body} wrap="truncate-end">
                    {opsStatus.auth_statement.slice(0, 80)}
                  </Text>
                </Box>
              ) : null}
            </Box>
          )}
        </Tile>
      )}

      {/* ── NEW ENGAGEMENT FORM ───────────────────────────────────────────────── */}
      {tab === "new" && (
        <Tile title="NEW ENGAGEMENT" led="violet" width={116}>
          {submitting ? (
            <Text color={COLORS.amber}>Creating engagement…</Text>
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text color={formField === 0 ? COLORS.amber : TEXT.dim}>
                  {formField === 0 ? "▶" : " "}
                </Text>
                <Text color={TEXT.dim}> Name:           </Text>
                <TextInput
                  value={formName}
                  onChange={setFormName}
                  onSubmit={_v => setFormField(1)}
                  focus={formField === 0}
                  placeholder="engagement name…"
                />
              </Box>
              <Box>
                <Text color={formField === 1 ? COLORS.amber : TEXT.dim}>
                  {formField === 1 ? "▶" : " "}
                </Text>
                <Text color={TEXT.dim}> Authorization:  </Text>
                <TextInput
                  value={formAuth}
                  onChange={setFormAuth}
                  onSubmit={_v => setFormField(2)}
                  focus={formField === 1}
                  placeholder="signed by / legal reference…"
                />
              </Box>
              <Box>
                <Text color={formField === 2 ? COLORS.amber : TEXT.dim}>
                  {formField === 2 ? "▶" : " "}
                </Text>
                <Text color={TEXT.dim}> Targets:        </Text>
                <TextInput
                  value={formTargets}
                  onChange={setFormTargets}
                  onSubmit={_v => setFormField(3)}
                  focus={formField === 2}
                  placeholder="e.g. HomeNet, 20:23:51:91:66:40, 192.168.0.0/24"
                />
              </Box>
              <Box>
                <Text color={formField === 3 ? COLORS.amber : TEXT.dim}>
                  {formField === 3 ? "▶" : " "}
                </Text>
                <Text color={TEXT.dim}> Duration (hrs): </Text>
                <TextInput
                  value={formDuration}
                  onChange={setFormDuration}
                  onSubmit={_v => handleSubmit()}
                  focus={formField === 3}
                  placeholder="4"
                />
              </Box>
              <Box marginTop={1}>
                <Text color={TEXT.dim}>
                  Enter:advance field  ↑↓:navigate  Enter on Duration = submit  Esc:cancel
                </Text>
              </Box>
            </Box>
          )}
        </Tile>
      )}

      {/* ── HISTORY TAB ──────────────────────────────────────────────────────── */}
      {tab === "history" && (
        <Tile title="ENGAGEMENT HISTORY" led="dim" width={116}>
          {!engList ? (
            <Text color={TEXT.dim}>loading…</Text>
          ) : engagements.length === 0 ? (
            <Text color={TEXT.dim}>no past engagements</Text>
          ) : (
            engagements.map((eng, i) => {
              const isSel = i === cursor;
              const led: LEDColor = eng.status === "active" ? "pink" : "dim";
              return (
                <Box key={eng.id}>
                  <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                  <StatusLED color={led} />
                  <Text color={isSel ? COLORS.amber : TEXT.body}>
                    {" "}{eng.name.slice(0, 28).padEnd(28)}
                  </Text>
                  <Text color={TEXT.dim}>{eng.status.padEnd(8)}</Text>
                  <Text color={TEXT.dim}>{fmtTs(eng.started_at).slice(0, 16).padEnd(18)}</Text>
                  <Text color={TEXT.dim}>{eng.targets_count}t</Text>
                </Box>
              );
            })
          )}
        </Tile>
      )}

      {/* ── AUDIT TAB ────────────────────────────────────────────────────────── */}
      {tab === "audit" && (
        <Tile title="AUDIT LOG" led="dim" width={116}>
          {!auditList ? (
            <Text color={TEXT.dim}>loading…</Text>
          ) : audits.length === 0 ? (
            <Text color={TEXT.dim}>no audit events</Text>
          ) : (
            audits.map((row, i) => {
              const isSel = i === cursor;
              return (
                <Box key={row.id}>
                  <Text color={isSel ? COLORS.amber : TEXT.dim}>{isSel ? "▶" : " "} </Text>
                  <Text color={TEXT.dim}>{row.ts.slice(0, 16).padEnd(18)}</Text>
                  <Text color={isSel ? COLORS.amber : TEXT.body}>
                    {row.kind.padEnd(10)}
                  </Text>
                  <Text color={TEXT.body} wrap="truncate-end">
                    {(row.command ?? "").slice(0, 40).padEnd(40)}
                  </Text>
                  <Text color={TEXT.dim}>{row.outcome ?? ""}</Text>
                </Box>
              );
            })
          )}
        </Tile>
      )}

      {/* Help / action bar */}
      <Box>
        {!inForm && (
          <Text color={TEXT.dim}>
            1-4:tab{tab === "active" ? "  e:end  k:killswitch" : ""}
            {tab === "history" || tab === "audit" ? "  j/k:move" : ""}
          </Text>
        )}
        {actionMsg ? <Text color={COLORS.amber}>  › {actionMsg}</Text> : null}
      </Box>
    </Box>
  );
}
