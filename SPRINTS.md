# Warlock / Titanium — Sprint Backlog

Queued goal-sprints, run **back-to-back** after each track completes. Each is a ready-to-lock
goal-contract (GOAL / ACCEPTANCE / NON-GOALS). Track A (Fluke-grade deck diagnostics) is **active**
— see [docs/A0-fluke-track-audit.md](docs/A0-fluke-track-audit.md). Full design context lives in the
Obsidian vault: `Frontier Infra/Agent Control Plane (AAR)/06 - Deck Ingest, Identity & Deployment`.

---

## Track A — Deck: Fluke-grade network diagnostics *(ACTIVE)*
A0 audit ✅ → **A1 wired + wireless ✅ (verified live on the deck)** → A3 wireless AirCheck-class →
**A6 Wi-Fi walk-test signal tracker** → A4 one-button report → A5 WaRL0c playbooks.
A2 (hardware: TDR/PoE/RF-spectrum + optional USB-GbE 2nd port) = BOM + SW-hooks spec only.

- **A6 — Wi-Fi walk-test signal tracker (heatmap / dead-zone finder).** GOAL: walk a space and see
  where APs are strong, weak, or dead. ACCEPTANCE: continuous per-AP RSSI sampling over time
  (`iw scan` / nl80211) with a live trace; classify **hot / warm / cold / dead** per sample against
  thresholds; per-BSSID min/max/avg + "last seen" so you can spot where an AP drops out; mark
  manual position tags (room/waypoint) for an indoor survey, and optionally bind GPS fixes (the deck
  has u-blox + 1-PPS) for an outdoor walk; export the trace for the A4 report + an eventual heatmap
  overlay. AirCheck/Ekahau-style. Surfaced in the UI; ties into A3 + `wireless_ids`. NON-GOALS:
  full floor-plan image calibration / Ekahau-grade interpolation (later); needs a portable walk —
  verify on the deck by walking it around a space.

---

## Track B — Control plane (AAR): identity → log → grants → ingest → producer *(NEXT)*

- **B1 — P0 identity.** GOAL: the org principal + each console resolve over `did:web`.
  ACCEPTANCE: `id.techmages.org/.well-known/did.json` live (CORS `*`); console
  `decks.techmages.org/<id>/.well-known/did.json` live; deck `aar_principal_did` flipped;
  verify.html resolves a real deck record online. NON-GOALS: the log, grants, ingest.
- **B2 — P1 transparency log + console enrollment.** GOAL: an independent append-only log issues
  signed receipts; consoles are enrolled/revocable. ACCEPTANCE: log service running (reuse
  acp-ingest `translog`+`registry`); deck attaches `log` → records reach **full L3**; enrollment +
  revocation entries committed. NON-GOALS: grants, payload ingest.
- **B3 — P2 grants.** GOAL: arming an engagement mints a principal-signed grant; every deck AAR
  carries `grant_ref`. ACCEPTANCE: engagement-arm → grant record (scope/not_after) committed;
  AARs emit `grant_ref`; out-of-scope = refused + logged. NON-GOALS: ingest deploy.
- **B4 — P4 deck producer.** GOAL: the deck rolls an engagement into a signed report + payload
  manifest and pushes it up. ACCEPTANCE: report builder (jobs/AARs → structured report); opt-in
  payload manifest; signed `acp-signature` push client (offline-tolerant). NON-GOALS: standing up
  the server (that's C1).
- **B5 — Verifier v2.** GOAL: verify.html does live `did:web` + L3 log-inclusion. ACCEPTANCE:
  paste a real deck AAR → resolves `sig.by` online + checks the transparency-log inclusion proof.

---

## Track C — Real-infra deploy + ops *(AFTER B)*

- **C1 — Stand up acp-ingest on the R750.** GOAL: a production-shaped, tailnet-only ingest instance.
  ACCEPTANCE: container on the R750, reachable only over the tailnet; the 4 controls in place
  (Tailscale ACLs segmenting decks; LUKS/at-rest; retention/purge; AAR provenance); a real deck
  upload lands + is queryable. NON-GOALS: public exposure, multi-tenant. **Gated on operator
  (hosting + secrets + go).**
- **C2 — Deck → ingest end-to-end on real hardware.** GOAL: a live engagement on the deck produces
  records/payloads that arrive at the R750 instance, validated + encrypted at rest.
- **C3 — Repo → `Titanium-Devops` + public.** Operator action (transfer + visibility); then verify
  Railway/site links resolve.

---

## Track D — Site / identity finish *(LIGHT, ANYTIME)*

- **D1 — Re-run aeocheck.ai** (was F/56) and clear remainders.
- **D2 — Public contact email** (`hello@techmages.org`) + a static-site form handler.
- **D3 — AVL `.agent` MIME** (`text/agent-view; version=1`) at the host so a strict live AVL
  validate passes.
- **D4 — Optional:** transparent lockup SVGs; `img/techmages-lockup.svg` (1.3 MB) optimization.

---

*Cadence: finish a track → lock the next sprint's contract → go. Verify on real infra, not locally.*
