#!/usr/bin/env node
// Prints the HTTP headers an agent session should send to the Browser Bridge daemon,
// as one JSON object on stdout.
//
//   $ node bin/headers.js
//   {"Authorization":"Bearer 9f...","X-Browser-Bridge-Session":"#12 fix-login", ...}
//
// Claude Code and Codex both run this in the session's own environment on every request
// (`headersHelper` / `http_headers_helper`), which is what carries the session name into
// a daemon that has no environment of its own. Both run it through a shell, give it 10
// seconds, and require one JSON object of string values on stdout.
//
// It must never fail: an exit code or a stray line here would break the session's MCP
// connection, and a missing daemon.json only means the installer has not run yet. So
// every path ends in a printed JSON object and exit 0.

import { readDaemonConfig } from "../host/protocol.js";
import { guessAgent, guessAccount } from "../mcp/session.js";

export function buildHeaders(env = process.env) {
  const headers = {};
  try {
    const config = readDaemonConfig(env);
    if (!config) return headers;
    headers.Authorization = `Bearer ${config.token}`;

    const name = typeof env.BROWSER_BRIDGE_SESSION_NAME === "string"
      ? env.BROWSER_BRIDGE_SESSION_NAME.trim()
      : "";
    if (name) headers["X-Browser-Bridge-Session"] = name;

    const agent = guessAgent(env);
    if (agent) headers["X-Browser-Bridge-Agent"] = agent;

    const account = guessAccount(env, agent);
    if (account) headers["X-Browser-Bridge-Account"] = account;
  } catch {
    // Whatever went wrong, an empty object is the only safe thing to say.
    return {};
  }
  return headers;
}

export function main(env = process.env, write = (text) => process.stdout.write(text)) {
  let headers;
  try {
    headers = buildHeaders(env);
  } catch {
    headers = {};
  }
  write(`${JSON.stringify(headers)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
