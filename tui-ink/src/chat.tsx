#!/usr/bin/env node
// Standalone `warlock-chat` entry — a SEPARATE Ink app from the HUD (dist/cli.js).
// No nav, no HUD clock, no telemetry polls: nothing competes with the chat, so
// the <Static> conversation log stays in the terminal's real scrollback and the
// screen never flickers or blanks on long answers.
//
//   node dist/chat.js --api http://<deck-host>:7777 --user <user> --password <pass>
//
// Provider is configured via env (read by parseAgentConfig): WARLOCK_AGENT_*.
// The deploy launcher sources /opt/warlock/agent.env then runs `node dist/chat.js`.

import { render } from "ink";
import { ChatApp } from "./chat/ChatApp.js";
import { createAgentRunner, missingConfig, parseAgentConfig } from "./lib/agent.js";
import { createApiClient } from "./lib/api.js";
import { parseConfig } from "./lib/config.js";

function main() {
  const config = parseConfig(); // --api/--user/--password for the FastAPI client
  const agentCfg = parseAgentConfig(); // WARLOCK_AGENT_* provider config from env
  const api = createApiClient(config);
  const runner = createAgentRunner({ api, config: agentCfg });

  const { waitUntilExit } = render(
    <ChatApp runner={runner} model={agentCfg.model} missing={missingConfig(agentCfg)} />,
  );

  void waitUntilExit().then(() => process.exit(0));
}

main();
