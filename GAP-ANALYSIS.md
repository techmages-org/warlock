# Warlock — Gap Analysis (2026-06-07)

Autonomous audit of the whole platform (backend · Ink TUI/agent/chat · web · security/coverage)
by a 4-auditor swarm. Full per-area detail in `/tmp/gap-{backend,tui,web,security}.md`.

## Baseline — post-fix (all green)
- Backend `pytest`: **185 passed** (336 `datetime.utcnow()` deprecation warnings — P2, see below).
- Ink TUI `vitest`: **122 passed** (21 files) + `tsc` build clean.
- Web: `tsc -b` clean + `vite build` clean (~493 kB js bundle).
- All P0/P1 fixes below are **DONE** (waves F1/F2/F3), deployed to the deck, and committed.

## Headline risks (P0) — all resolved
| # | Area | Finding | Impact | Status |
|---|------|---------|--------|--------|
| 1 | `api/ws.py` | **`/ws` was fully unauthenticated** — "auth per-socket" comment was false; `accept()` with no check. Any LAN client got the whole event bus incl. cracked passphrases in audit rows. | Sensitive data exposure on the LAN | **DONE (F1)** — Basic auth on handshake, **flag-gated** `WARLOCK_WS_AUTH` (default OFF: browser WS can't set the header → would 403 the web bus). TUI ws client sends it. Web header-free path = follow-up. |
| 2 | web `Pager.tsx` / `AudioSettings.tsx` | **Hardcoded `Basic warlock:warlock`** (btoa) in two components → readable in the built JS bundle. | Cred in artifact (low real risk: bundle is auth-gated, but bad practice) | **DONE (F3)** — both now use shared `lib/api.ts` |
| 3 | `dashboard.py` | **5 sync `subprocess.run()` inside `async def status()`** → up to ~10s event-loop stall every poll (the dashboard latency we chased). | Whole API frozen during polls | **DONE (F1)** — `asyncio.to_thread` + `gather` |
| 4 | `wireless_ids.py` | **sync `httpx.Client` inside `async def detections()`** → up to 12s block that can stall the killswitch endpoint. | Killswitch latency under IDS load | **DONE (F1)** — `httpx.AsyncClient` |
| 5 | `server_audit.py` | **SSH password (`sshpass -p`) stored plaintext** in `AuditEntry.command` (SQLite). | Secret at rest in audit log | **DONE (F1)** — `sshpass -e` (env) + redact; secret never in argv (test-asserted) |
| 6 | web | `/audio` dead nav link; 3 stub pages (wifi_offensive/sdr_offensive/esp32_companion) | nav UX / parity | `/audio` **DONE (F3)**; stubs **DEFERRED** (offensive lives in the Wireless flow) |

## P1 — fixed this run
- **net_recon `portscan` gate/audit hole** — `profile=vuln` vs RFC1918 could bypass the gate, and accepted scans wrote **no audit row**. → **DONE (F1)**: gate enforced for all profiles + `job.submit`/`scope.violation` audit rows (tests added).
- **wireless.tsx RECON/LOOT hidden-selection (SAFETY)** — `slice(0,6)` with no scroll window; the `›` selection could scroll off-screen → operator could lock/fire an AP they couldn't see. → **DONE (F2)**: `windowOf()` + `+N more`.
- **wireless_ids.tsx** `slice(0,11)` silent truncation → **DONE (F2)**: window + count.
- **6 screens fixed-width tiles** (ops/system/audio/wireless_ids/wireless/esp32) overflowed ≤116-col SSH → **DONE (F2)**: `useStdout().columns`.
- **useInput closure-staleness** not applied to ops/system/audio → **DONE (F2)**: ref pattern, consistent across screens.
- **chat `/tools`** showed a generic summary, not the real tool names → **DONE (F2)**: lists `READ_ENDPOINTS`.
- **`lib/ws.ts` (web) dead/unused** — Pager polls 2.5s instead of the bus. → DEFERRED (couples with the web header-free /ws-auth follow-up).
- **No rate-limit / single shared cred / no RBAC** (binds 0.0.0.0:7777) → Wave 8 (team-grade). DEFERRED — needs Jason.

## P2 / tech-debt
- **309 `datetime.utcnow()` deprecation warnings** (backend-wide) → migrate to `datetime.now(UTC)`. DEFERRED (mechanical, large; own wave).
- Web bundle ~494 kB (leaflet weight) → code-split. DEFERRED.
- In-memory job queues (crack/server_audit) not durable across restart. DEFERRED (MVP-acceptable).
- Empty `WARLOCK_WEB_PASSWORD` silently disables auth → startup WARNING. **DONE (F1)**.
- `agent.env` not in `.gitignore` → **DONE (F1)** (added).

## Test-coverage gaps
- Backend: `portscan` + its gate, `_check_auth`, `/ws` auth — **untested** → adding (F1).
- TUI: ops/system/audio interaction — untested → adding (F2).
- Web: **0 test files** (no runner configured) → DEFERRED (stand up vitest+RTL as its own task).
- Confirmed solid: killswitch (runner+crack+audit, 2 tests), agent read-only guarantee (faux-provider loop + POST-throws mock), all 19 agent tools GET-only.

## Stale items to CLOSE (verified resolved)
- "Killswitch doesn't reach crack + audit queues" (closet ×2, 2026-06-04/05) — **RESOLVED** in `engagement.py` (188-246) + 2 passing tests.
- "Wireless flow LOOT placeholder until Pager lands" — **RESOLVED** (`Pager.tsx` exists + wired).
- `crack.py` docstring "killswitch TODO" — **stale comment** (already wired) → tidy.

## Escalate to Jason (not auto-fixable)
- Wave 8 team-grade: multi-operator auth + RBAC, rate-limiting, replacing `warlock/warlock`.
- Offensive feature completion: eaphammer (501), WPS, net_recon offensive (Responder/CME) — features, need authorization context.
- U2 deploy runtime decision (already Node-on-CM5, done) — and whether to remove the superseded Textual TUI (`94e3757`).
- ADS-B 3 live spot-checks (DB-enabled readsb? wind/temp keys? nav_altitude_fms) — orchestrator will check against live `:8504` this run.

## Fix plan (this autonomous run) — COMPLETE
- **F1 (backend·opus): DONE** — /ws auth (flag-gated OFF), dashboard async, wireless_ids async, sshpass `-e` redact, portscan gate+audit, empty-pw warning, .gitignore agent.env + tests. 185 pytest green.
- **F2 (tui·sonnet): DONE** — wireless selection-window, ids truncation, fixed-width (`useStdout`), useInput refs, chat /tools, ws.ts client-auth + tests. 122 vitest green.
- **F3 (web·sonnet): DONE** — hardcoded-creds → shared `lib/api.ts`, /audio page. tsc+build clean.
- Orchestrator: verified all suites → deployed to deck → live checks → stale closet items closed → docs + morning report.
- **Deferred / escalate** (documented above) → next waves / Jason: web header-free /ws auth (token/cookie), ScopeAllowlist CIDR-vs-CIDR bug, `datetime.utcnow()` migration (336 warnings), web stub pages + test runner + bundle split, Wave 8 (multi-operator auth/RBAC/rate-limit), offensive feature completion.
