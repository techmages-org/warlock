# Warlock / Titanium — Sprint Backlog

Queued goal-sprints, run **back-to-back** after each track completes. Each is a ready-to-lock
goal-contract (GOAL / ACCEPTANCE / NON-GOALS). Track A (Fluke-grade deck diagnostics) is **active**
— see [docs/A0-fluke-track-audit.md](docs/A0-fluke-track-audit.md). Full design context lives in the
Obsidian vault: `Frontier Infra/Agent Control Plane (AAR)/06 - Deck Ingest, Identity & Deployment`.

---

## Track A — Deck: Fluke-grade network diagnostics *(ACTIVE)*
A0 audit ✅ (this doc set) → A1 wired LinkRunner-class → A3 wireless AirCheck-class → A4 one-button
report → A5 WaRL0c playbooks. A2 (hardware: TDR/PoE/spectrum) = BOM + SW-hooks spec only.

---

## Track B — Control plane (AAR): identity → log → grants → ingest → producer *(NEXT)*

- **B1 — P0 identity.** GOAL: the org principal + each console resolve over `did:web`.
  ACCEPTANCE: `id.titaniumcomputing.com/.well-known/did.json` live (CORS `*`); console
  `decks.titaniumcomputing.com/<id>/.well-known/did.json` live; deck `aar_principal_did` flipped;
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
