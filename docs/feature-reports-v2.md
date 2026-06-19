# Feature: Reports Tab v2 — Engagement-Scoped Graphical Reports

> Replaces the broken Reports tab (currently redirects to dashboard).
> Generates multiple graphical reports viewable in-dashboard, scoped to a specific
> engagement window, in two flavors: deck-local (HUD theme) and client-facing.

## Current State (Problem)

- No `/report` route exists in App.tsx — catch-all redirects to /dashboard
- Backend `report.py` only does network-health surveys (netdiag + wifi_analyzer)
- No engagement-scoped data aggregation
- No graphical/charts capability
- No client-facing report generator
- No AI integration for report formatting

## Requirements

### 1. Engagement Window Scoping

Reports filter ALL data to the engagement time window:
- Start = engagement.start timestamp (from AAR records or engagement API)
- End = engagement.stop timestamp
- Any captures, tracks, PCAPs, logs OUTSIDE that window are excluded
- User can manually override the window if needed

Data sources to scope:
- WiFi captures (airodump CSV/PCAP) — filter by "first time seen" timestamps
- GPS tracks (GPX) — filter by trackpoint timestamps
- AAR records — filter by issued timestamp
- Loot artifacts — filter by mtime within window
- Network recon data — filter by capture session timestamps

### 2. Report Types (Deck-Local)

Viewable inside the dashboard, matching the deck's dark HUD theme.

Each report is a self-contained visualization page rendered in-app:

**a. Wardrive Summary**
- AP count over time (line chart)
- Signal strength distribution (histogram)
- Channel utilization (bar chart)
- Encryption breakdown (pie/donut: WPA3/WPA2/Open/WEP)
- Top SSIDs by frequency (horizontal bar)
- GPS map overlay (AP locations on a map, if geotagged)
- Unique vs total BSSID count
- Client device count

**b. Network Attack Surface**
- Discovered hosts/services (from net_recon data)
- Port distribution (bar chart)
- OS fingerprint breakdown
- Exposure summary (open/closed/filtered)

**c. Engagement Timeline**
- Chronological event log from AAR records
- Scope violations flagged
- Module activity timeline (what ran when)
- Duration breakdown by activity type

**d. Loot Inventory**
- Artifact counts by type
- Disk usage by type
- Capture quality metrics (handshakes captured, unique clients, etc.)

**e. GPS / Movement**
- Track map (polylines on a map widget)
- Speed over time
- Elevation profile
- Coverage area calculation

### 3. Report Types (Client-Facing)

Separate, exportable reports for handoff. Different visual style:
- Clean, professional light theme (not dark HUD)
- Company branding (TechMages / Titanium Computing)
- Redacted/sanitized — no internal deck identifiers, no raw MAC addresses
  unless explicitly included
- Executive summary section
- Findings table with severity ratings
- Recommendations section
- Methodology summary (what was tested, scope)
- Appendix with full data tables

### 4. AI-Assisted Client Reports

Before generating an AI-formatted client report, run preflight checks:

```
PREFLIGHT CHECKLIST (must pass before AI report generation):
  [ ] AI enabled in config?        (check config.yaml)
  [ ] Internet reachable?          (ping gateway + DNS + WAN check)
  [ ] LLM API accessible?          (test configured provider endpoint)
  [ ] API key valid?               (quick auth test)
```

If any check fails:
- Report which checks failed
- Offer to generate a non-AI template report instead
- Log the failure for diagnostics

If all pass:
- Feed aggregated engagement data to the LLM
- LLM generates: executive summary, findings narrative, recommendations
- Operator reviews before finalizing (preview → approve → export)
- Output as PDF-ready HTML or downloadable document

### 5. Automation

- Auto-generate deck-local reports on engagement end
- Configurable: which report types to auto-generate
- Client reports are always manual (operator must approve AI output)
- Reports stored in engagement directory and indexed in Loot tab

### 6. API Design

```
GET  /api/report/engagements              — list past engagements with time windows
GET  /api/report/templates                — available report templates
POST /api/report/generate/{template}      — generate a specific report
     Body: { engagement_id: str|None, window: {start, end}|None }
     Returns: { report_id, type, data, rendered_html }

GET  /api/report/view/{report_id}         — view rendered report (deck-local HTML)
GET  /api/report/export/{report_id}       — download (PDF/HTML/JSON)

POST /api/report/preflight                — run AI preflight checks
     Returns: { ai_enabled, internet, api_accessible, key_valid, all_pass }

POST /api/report/client                   — generate client-facing report
     Body: { engagement_id, template, use_ai: bool, redact: bool }
     Returns: { report_id, preview_html, requires_approval: bool }

POST /api/report/client/{report_id}/approve  — approve AI-generated report
POST /api/report/client/{report_id}/reject   — reject and discard

GET  /api/report/list                     — list all generated reports
```

### 7. Frontend Design

**Reports page layout:**
- Top: engagement selector (dropdown of past engagements + window display)
- Left: report template cards (clickable — generate/view)
- Center: rendered report view (charts, maps, tables)
- Bottom: export buttons (PDF, HTML, JSON)

**Charts library:**
- Use lightweight SVG-based charts (recharts or hand-rolled D3)
- Match HUD color palette: amber, violet, cyan, mint on dark background
- No heavy dependencies

**Client report view:**
- Separate render path with light theme
- Preview mode with approve/reject buttons for AI reports
- Export to PDF (browser print or server-side)

## Architecture Notes

- Report templates are Python classes implementing a common interface:
  `gather(engagement_window) -> data_dict`
  `render_deck(data) -> html_string`
  `render_client(data) -> html_string`  (optional, may use AI)

- Data aggregation queries the same loot/artifact directories
- GPS map overlay needs a lightweight tile renderer (leaflet.js minimal)
- Charts rendered client-side in React for interactivity
- Client-facing reports can be rendered server-side for export

## Implementation Priority

1. Fix the route (stop redirecting to dashboard)
2. Engagement selector + window scoping
3. Wardrive Summary report (deck-local, with charts) — highest value
4. Loot Inventory report (deck-local)
5. Engagement Timeline report (deck-local)
6. Client-facing report template (non-AI first)
7. AI preflight checks
8. AI-assisted client report generation
9. Automation hooks (auto-generate on engagement end)
