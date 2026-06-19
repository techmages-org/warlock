# Feature: Loot Tab

> Unified artifact browser — "grab the loot" for any engagement.
> Think Hak5's loot concept: one tab, all collected data, organized and downloadable.

## Problem

Warlock collects artifacts across many modules (WiFi recon, SDR, GPS, net recon,
crack, capture, reports, handshakes), but they're scattered across separate
directories with no unified browse/download interface:

```
~/warlock/captures/wifi/     # airodump pcaps, CSVs, geo.json, KML exports
~/warlock/captures/sdr/      # SDR IQ recordings
~/warlock/captures/test/     # test captures
~/warlock/tracks/            # GPS GPX tracks
~/warlock/handshakes/        # WiFi EAPOL handshakes
~/warlock/captures/wifi/cracked/  # cracked hash files
~/warlock/captures/wifi/exports/  # CSV + KML exports
~/warlock/reports/           # generated engagement reports
~/warlock/aar/records/       # signed attestation records
~/warlock/audits/            # audit logs
~/warlock/wireless_ids/      # WIDS detection logs
~/warlock/walktest/          # WiFi coverage walk-test data
~/warlock/engagements/<id>/  # per-engagement metadata
```

Each module has its own download endpoint (capture/download/{id},
report/download/{id}, gps/tracks/{filename}, wifi_recon/export), but there's no
"show me everything collected during this engagement" view.

## Proposal

### 1. Backend: GET /api/loot (artifact index)

Scans all artifact directories, returns a unified, typed, sortable list:

```json
{
  "ok": true,
  "artifacts": [
    {
      "id": "airodump-20260619-142632",
      "type": "wifi_pcap",
      "module": "wifi_recon",
      "path": "captures/wifi/airodump-20260619-142632-01.cap",
      "size_bytes": 1600000,
      "created_at": "2026-06-19T14:26:32Z",
      "engagement_id": null,
      "download_url": "/api/loot/download/airodump-20260619-142632-01.cap",
      "preview_url": "/api/wifi_recon/aps"
    },
    {
      "id": "20260619-142631",
      "type": "gps_track",
      "module": "gps",
      "path": "tracks/20260619-142631.gpx",
      "size_bytes": 300,
      "created_at": "2026-06-19T14:26:31Z",
      "download_url": "/api/loot/download/tracks/20260619-142631.gpx"
    }
  ],
  "total_size_bytes": 7048576000,
  "by_type": {
    "wifi_pcap": { "count": 14, "size_bytes": 5000000000 },
    "wifi_csv": { "count": 14, "size_bytes": 800000 },
    "wifi_geojson": { "count": 5, "size_bytes": 80000 },
    "gps_track": { "count": 2, "size_bytes": 500 },
    "report": { "count": 2, "size_bytes": 7000 }
  }
}
```

**Artifact types:**
| Type | Source | Extension(s) |
|------|--------|-------------|
| `wifi_pcap` | wifi_recon / wifi_offensive | `.cap` |
| `wifi_csv` | wifi_recon | `.csv` |
| `wifi_geojson` | wifi_recon | `-geo.json` |
| `wifi_kml` | wifi_recon export | `.kml` |
| `wifi_handshake` | wifi_offensive | `.pcap` in handshakes/ |
| `cracked_hash` | crack | `.22000`, `.16800`, `.txt` in cracked/ |
| `sdr_iq` | sdr_offensive | `.cu8`, `.cs8`, `.raw` |
| `gps_track` | gps | `.gpx` |
| `net_pcap` | capture | `.pcap` |
| `report` | report | `.html`, `.json` |
| `aar_record` | aar | `.json` in aar/records/ |
| `walk_test` | wifi_analyzer | `.json` in walktest/ |
| `wids_log` | wireless_ids | `.log`, `.csv` |

**Query params:**
- `?engagement_id=<uuid>` — filter to artifacts created during an engagement
  (by timestamp overlap)
- `?module=wifi_recon` — filter by source module
- `?type=wifi_pcap` — filter by artifact type
- `?since=ISO8601` — filter by creation time

### 2. Backend: GET /api/loot/download/{path:path}

Unified download endpoint. Validates path stays within `~/warlock/` (no path
traversal). Returns `FileResponse` with appropriate content-type based on
extension.

### 3. Backend: POST /api/loot/archive

Zip-on-the-fly for bulk download:

```json
POST /api/loot/archive
{ "paths": ["captures/wifi/airodump-20260619-142632-01.cap", "tracks/20260619-142631.gpx"] }
→ Returns StreamingResponse (application/zip)
```

Optional: `?engagement_id=<uuid>` to zip everything from an engagement.

### 4. Backend: DELETE /api/loot/{path:path}

Delete an artifact (with confirmation on frontend). Useful for purging the
massive airodump .log files (some are 800GB+).

### 5. Frontend: Loot.tsx page

```
┌──────────────────────────────────────────────────┐
│  LOOT                                    [HUD]   │
│                                                  │
│  Filter: [All Types ▾] [All Modules ▾] [Search] │
│  Engagement: [None ▾]                            │
│                                                  │
│  Total: 7.0 GB across 37 artifacts              │
│  ┌─ WiFi Pcap (14) ──── 5.0 GB ───────────────┐ │
│  │  airodump-20260619-142632-01.cap   1.6 MB  │ │
│  │  [Download] [Preview] [Delete]              │ │
│  │  airodump-20260619-135236-01.cap   3.6 MB  │ │
│  │  [Download] [Preview] [Delete]              │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─ GPS Track (2) ──── 500 B ─────────────────┐ │
│  │  20260619-142631.gpx              300 B    │ │
│  │  [Download] [Map Preview]                   │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─ Report (2) ──── 7 KB ─────────────────────┐ │
│  │  rpt-1781045428.html              4.0 KB   │ │
│  │  [Download] [Open]                           │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  [Download All as ZIP]                           │
└──────────────────────────────────────────────────┘
```

**Features:**
- Grouped by type, collapsible sections
- Sort by name, size, or date
- Individual download buttons
- Bulk select + "Download as ZIP"
- Engagement filter (shows only artifacts from selected engagement time window)
- Inline previews where possible:
  - CSV → sortable table
  - GeoJSON/KML → mini map
  - GPX → track on map
  - Report HTML → iframe
  - Pcap → summary (packet count, protocols)
- Disk usage indicator (flag when captures dir > X GB)
- Delete button for cleanup (especially those massive .log files)

### 6. Engagement integration

When an engagement is active or selected:
- Artifacts created during the engagement's time window are auto-tagged
- Engagement report page gets a "Loot" section linking to filtered view
- AAR records for the engagement are included as artifacts

## Implementation Notes

- Artifact scanner should be cached with a TTL (don't scan filesystem on every
  request — those capture dirs can have hundreds of files)
- The .log files from airodump are enormous (100GB-800GB each) — these should
  be excluded from the loot view by default or shown with a warning, and there
  should be a cleanup utility
- Path validation: resolved path must start with the warlock data root
- Consider streaming large files rather than loading into memory

## Acceptance Criteria

1. GET /api/loot returns all artifacts with type, size, date, module
2. Individual file download works for all artifact types
3. ZIP archive download works for selected files
4. Web UI Loot tab is accessible from the nav
5. Engagement filter narrows artifacts to the engagement time window
6. Disk usage is displayed and oversized files are flagged
