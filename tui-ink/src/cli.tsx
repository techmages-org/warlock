#!/usr/bin/env node
// Entry point: parse CLI config → build the auth'd API client + WS event bus →
// provide them to the whole app via context → render(<App/>).
//
//   node dist/cli.js --api http://<deck-host>:7777 --user <user> --password <pass>
//
// (dev: `npm run dev -- --api … --user … --password …`)

import { render } from "ink";
import { App } from "./app.js";
import { WarlockProvider, type WarlockContextValue } from "./context.js";
import { createApiClient } from "./lib/api.js";
import { parseConfig } from "./lib/config.js";
import { createEventBus } from "./lib/ws.js";

function main() {
  const config = parseConfig();
  const api = createApiClient(config);
  const bus = createEventBus(config);
  const value: WarlockContextValue = { config, api, bus };

  const { waitUntilExit } = render(
    <WarlockProvider value={value}>
      <App />
    </WarlockProvider>,
  );

  void waitUntilExit().then(() => {
    bus.close();
    process.exit(0);
  });
}

main();
