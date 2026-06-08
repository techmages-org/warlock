# did:web hosting — Agent Control Plane identity (B1)

Two `did.json` documents that let anyone resolve the **principal** (the org that answers for the
deck) and the **console** (this deck) public keys offline-verifiably. Generated from the deck's keys;
**hosting them is the operator step** (DNS + a static host with CORS).

## What goes where (did:web resolution rules)

| DID | Serve at | File |
|---|---|---|
| `did:web:id.techmages.org` (principal) | `https://id.techmages.org/.well-known/did.json` | `id.techmages.org/.well-known/did.json` |
| `did:web:decks.techmages.org:warlock-cm5-01` (console) | `https://decks.techmages.org/warlock-cm5-01/did.json` | `decks.techmages.org/warlock-cm5-01/did.json` |

A **bare** did:web → `/.well-known/did.json`; a **path-suffixed** did:web (`:warlock-cm5-01`) →
`/<path>/did.json` (no `.well-known`).

## Required HTTP headers (every did.json)

```
Access-Control-Allow-Origin: *          # the browser verifier (verify.html) fetches cross-origin
Content-Type: application/did+json      # (application/json also accepted)
```

The `_headers` file applies these on **Cloudflare Pages**. For Caddy: `header /*/did.json
Access-Control-Allow-Origin "*"`; for nginx: `add_header Access-Control-Allow-Origin *;`.

## Hosting (one option)

Two tiny **Cloudflare Pages** projects (or one host each):
- point `id.techmages.org` at the `id.techmages.org/` dir
- point `decks.techmages.org` at the `decks.techmages.org/` dir

Both are static — just the `did.json` + `_headers`. No build.

## Verify after hosting

```bash
# principal + console resolve online and a real deck AAR verifies against them:
curl -s https://id.techmages.org/.well-known/did.json | jq .id
curl -s https://decks.techmages.org/warlock-cm5-01/did.json | jq .id
node tools/aar.mjs verify <a-deck-aar>.json        # resolves did:web online → L1+
```

## Keys
- **Console** private key: on the deck at `<WARLOCK_DATA>/keys/ed25519.jwk.json` (0600). The deck
  signs its AARs with it (`sig.by = subject`).
- **Principal** private key: on the deck at `<WARLOCK_DATA>/keys/principal.jwk.json` (0600), used to
  sign **grants + enrollments** (B2/B3). *Simplification for the single-deck scaffold — in a
  multi-deck deployment the principal key lives in the org control plane, not each deck.*
- Only the **public** `did.json` documents in this folder get published. Private keys never leave the deck.
