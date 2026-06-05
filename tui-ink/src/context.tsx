// React context that threads the single API client, event bus, and config to
// every screen. Screens call useApi()/useBus()/useConfig() and NEVER construct
// their own client. Tests wrap a screen in <WarlockProvider value={...}> with a
// mock client (see README "How to add a screen").

import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "./lib/api.js";
import type { Config } from "./lib/config.js";
import type { EventBus } from "./lib/ws.js";

export type WarlockContextValue = {
  config: Config;
  api: ApiClient;
  bus: EventBus;
};

const WarlockContext = createContext<WarlockContextValue | null>(null);

export function WarlockProvider({
  value,
  children,
}: {
  value: WarlockContextValue;
  children: ReactNode;
}) {
  return <WarlockContext.Provider value={value}>{children}</WarlockContext.Provider>;
}

function useWarlock(): WarlockContextValue {
  const ctx = useContext(WarlockContext);
  if (!ctx) {
    throw new Error("useWarlock must be used within <WarlockProvider> — wrap your screen in the provider (see README).");
  }
  return ctx;
}

export function useApi(): ApiClient {
  return useWarlock().api;
}

export function useBus(): EventBus {
  return useWarlock().bus;
}

export function useConfig(): Config {
  return useWarlock().config;
}
