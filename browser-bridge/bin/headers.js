#!/usr/bin/env node
// Prints the HTTP headers an agent session should send to the Browser Bridge daemon,
// as one JSON object on stdout.
//
//   $ node bin/headers.js
//   {"Authorization":"Bearer 9f...","X-Browser-Bridge-Session":"#12 fix-login", ...}
//
// Claude Code runs this in the session's own environment on every request
// (`headersHelper`), which is what carries the session name into a daemon that has no
// environment of its own. Codex's `http_headers_helper` gets no environment, so there this
// only carries the token and the name arrives through `env_http_headers`. Both run it
// through a shell, give it 10 seconds, and require one JSON object of string values.
//
// It must never fail, and it must never print a value the caller cannot put in a header:
// an exit code, a stray line, or a `\r\n` inside a value would break the session's MCP
// connection outright (the client's `Headers` constructor throws, and then the browser
// server does not connect at all - not one call fails, all of them do). A missing
// daemon.json only means the installer has not run yet. So every path ends in a printed
// JSON object and exit 0, and every value goes through the same sanitiser the daemon uses.
//
// Nothing here may import the MCP SDK: this runs on every request, and loading the SDK and
// zod cost ~60 ms a time. `test/headers.test.js` holds that line.

import { readDaemonConfig } from "../host/protocol.js";
import { encodeHeaderValue, guessAgent, guessAccount, sanitizeHeaderValue } from "../mcp/identity.js";

export function buildHeaders(env = process.env) {
  const headers = {};
  try {
    const config = readDaemonConfig(env);
    if (!config) return headers;
    // The token is ours, not the environment's: hex from daemon.json, never user input.
    headers.Authorization = `Bearer ${config.token}`;

    // Percent-encoded when it is not plain printable ASCII: a code point above U+00FF makes
    // the client's own Headers constructor throw, which stops the browser server connecting at
    // all. An em dash in a branch name should cost nothing, so it is encoded, not dropped.
    const add = (name, value, max) => {
      const clean = sanitizeHeaderValue(value, max);
      if (clean !== null) headers[name] = encodeHeaderValue(clean);
    };

    add("X-Browser-Bridge-Session", env.BROWSER_BRIDGE_SESSION_NAME);
    const agent = guessAgent(env);
    add("X-Browser-Bridge-Agent", agent, 40);
    add("X-Browser-Bridge-Account", guessAccount(env, agent));
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
