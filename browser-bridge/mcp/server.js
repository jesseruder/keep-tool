#!/usr/bin/env node
// The stdio MCP server: one process per agent session, talking to the host's socket.
//
// This is the fallback shape. `node bin/install.js` registers the shared HTTP daemon
// instead (`mcp/daemon.js`), which costs no process per session; `--stdio` registers
// this, and the driving scripts run it directly. All of the behaviour lives in
// `mcp/session.js`, so the two shapes cannot drift apart.

import { randomUUID } from "node:crypto";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { socketPath } from "../host/protocol.js";
import { BridgeClient } from "./client.js";
import { createSessionServer, sessionIdentity } from "./session.js";

export { sessionIdentity };

const identity = sessionIdentity();
const client = new BridgeClient({
  socketPath: socketPath(),
  sessionKey: randomUUID(),
  name: identity.name,
  agent: identity.agent,
  account: identity.account,
});

const server = createSessionServer({ ...identity, client });

async function shutdown() {
  try {
    await client.close();
  } catch {
    // nothing to do
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
