# Warlock TUI — Ink edition (`tui-ink/`)

A terminal HUD that mirrors the Warlock **web** UI (`web/`) and talks to the
**same FastAPI** backend. Built with [Ink](https://github.com/vadimdemedes/ink)
(React-for-CLI), TypeScript, ESM. Designed for the uConsole CM5 (**1280×480
landscape** → ~120 cols × ~24 rows): wide rows of short tiles, never tall stacks.

## Run

```bash
npm install
npm run build      # tsc → dist/   (must exit clean)
npm test           # vitest        (must be all green)

# live deck (Basic auth — Node has no cookie jar, creds go on the CLI):
node dist/cli.js --api http://<deck-host>:7777 --user <user> --password <pass>
# dev (no build):
npm run dev -- --api http://127.0.0.1:7777 --user <user> --password <pass>
```

CLI flags (`src/lib/config.ts`): `--api <url>` (default `http://127.0.0.1:7777`),
`--user`, `--password`. Both `--user warlock` and `--user=warlock` work.

## Keys

`g`+key goes to a screen (chord). `Ctrl+K` killswitch (confirm modal), `Ctrl+E`
engagement status, `?` help, `q` quit. Bindings live in **`src/lib/nav.ts`**
(`NAV_KEYS`). The pinned **Wireless** guided flow (frontend-only, not a backend
module) is `g f` and is pinned first in the nav, exactly like web `App.tsx`.

> Headless note: Ink needs a TTY for keys. Under a non-TTY stdin (e.g. an agent
> pane) input is disabled gracefully (`isActive: !!isRawModeSupported`) — the app
> still renders and polls **live** telemetry, it just can't take keystrokes.

## Architecture / contract (do not break)

- **`src/lib/`** — `config.ts` (CLI → `{apiUrl, auth}`), `api.ts` (the auth'd
  `ApiClient`; sends `Authorization: Basic …` on every request), `ws.ts` (the
  `ws`-package reconnecting event bus), `types.ts`, `theme.ts`, `hooks.ts`
  (`usePoll`). **Owned by W0 — do not edit.**
- **`src/context.tsx`** — `WarlockProvider` + `useApi()`/`useBus()`/`useConfig()`.
  Screens read the **one** shared client from context; they never `new` one.
- **`src/components/`** — HUD primitives (`Tile`, `StatusLED`, `BigValue`,
  `HudBar`, `EngagementBanner`, `KillswitchModal`, `Nav`, `ModuleHeader`).
  **Owned by W0 — do not edit.**
- **`src/screens/<id>.tsx`** — one file per module id, each `export function
  Screen()`. **`src/screens/registry.tsx`** imports all 16 by id with a fixed
  export name, so four workers edit different files with zero merge conflicts.
  **Owned by W0 — do not edit `registry.tsx`.**
- **NodeNext modules:** every relative import **must** end in `.js`
  (`from "../lib/api.js"`) — tsc errors without it, and the live `node dist/cli.js`
  run dies with `ERR_MODULE_NOT_FOUND` if you skip it. This applies to your
  screen files too.

## How to add a screen (W1–W4 — this is the whole recipe)

The registry already imports your id. You only touch **two files**: your screen
and its test. Replicate `src/screens/dashboard.tsx` (the reference).

1. **Replace the shim** `src/screens/<id>.tsx`. Delete the `WARLOCK_TODO_SCREEN`
   comment. Keep `export function Screen()`. Build the screen on the Dashboard
   pattern: `const api = useApi()` → `usePoll(() => api.get("/api/<id>/…"), 2000,
   [api])` → render `<ModuleHeader …/>` + loading/error guards + compact `<Tile>`
   rows. **Register nothing** — `registry.tsx` already maps your id → `Screen`.
2. **Add a render test** `src/screens/<id>.test.tsx` copying
   `src/__tests__/dashboard.test.tsx`: mock the client, wrap in `WarlockProvider`,
   **await** the load, then assert `lastFrame()`, then `unmount()`:
   ```tsx
   const ctx = { config:{apiUrl:"http://t",auth:null},
     api:{ baseUrl:"http://t", get: vi.fn(async()=>FIXTURE), post: vi.fn() },
     bus:{ subscribe:()=>()=>{}, close(){} } };
   const { lastFrame, unmount } = render(
     <WarlockProvider value={ctx}><Screen/></WarlockProvider>);
   await vi.waitFor(() => expect(lastFrame()).toContain("…"));  // screen mounts "loading" first
   expect(lastFrame()).toContain("…"); unmount();               // unmount stops the poll interval
   ```
3. **Verify:** `npm run build` clean · `npm test` green · `grep -rn
   WARLOCK_TODO_SCREEN src/screens` no longer lists your file. Done.

Use `Aircraft` from `src/lib/types.ts` for the `sdr` screen's ADS-B rows (full
readsb intel set, per ORCHESTRATION.md). Keep the dark HUD theme (`src/lib/theme.ts`).

## Deploy

Not wired into any deploy script (the CM5 deck has no Node yet — resolve at push
time: install Node on the CM5 *or* ship a `bun build --compile` binary).
