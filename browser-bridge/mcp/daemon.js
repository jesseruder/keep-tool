#!/usr/bin/env node
// One long-lived MCP server for every agent session on this machine, over streamable
// HTTP on loopback.
//
// Why: neither Claude Code nor Codex can lazy-start a stdio MCP server, so every session
// used to spawn `mcp/server.js` at startup whether or not it ever touched the browser —
// 35 processes and 828 MB resident on 2026-09-18. A session now costs one HTTP client
// inside the agent and no process at all.
//
// One MCP session (`Mcp-Session-Id`) = one `StreamableHTTPServerTransport` = one
// `createSessionServer` = one `BridgeClient` with its own `sessionKey`. That is exactly
// what a stdio process was, so the host and the extension see no difference: one socket
// client is still one session is still one tab group. Neither is changed by any of this.

import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DEFAULT_DAEMON_PORT, isMainModule, readDaemonConfig, sessionsPath, socketPath } from "../host/protocol.js";
import { BridgeClient } from "./client.js";
import {
  MAX_HEADER_VALUE_LENGTH,
  deriveRegistryKey,
  deriveSessionKey,
  readHeaderValue,
  sanitizeHeaderValue,
} from "./identity.js";
import { SessionRegistry } from "./registry.js";
import { createSessionServer } from "./session.js";

// Re-exported so the tests and any caller keep finding them here.
export { MAX_HEADER_VALUE_LENGTH, sanitizeHeaderValue };

/** More than this many live sessions is a runaway, not a Tuesday. */
export const MAX_LIVE_SESSIONS = 200;
/**
 * A session id has to be safe to put in a log line, a Map key and an HMAC. Both clients send
 * a UUID; this only rules out the absurd.
 */
const VALID_SESSION_ID = /^[\x20-\x7e]{1,128}$/;

/** Tool calls carry file_upload paths and GIF options, never bytes; 16 MiB is generous. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** A session nobody has used for this long is closed as if the client had sent DELETE. */
export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60_000;
/**
 * How long a session with no event stream and no traffic at all gets before it is closed.
 *
 * Codex sends `DELETE /mcp` when it exits; Claude Code does not, and waiting out the
 * 24-hour idle window would leave its tab group listed as live and never tidy up its blank
 * tabs. What Claude Code *does* do is hold the standalone GET event stream open for the life
 * of the session, so the stream going away is a hint that the agent has gone.
 *
 * Only a hint, though: the SDK's client gives up reconnecting that stream after two attempts
 * (~2.5 s), so a laptop that sleeps, or a daemon restarted for a landing, leaves a perfectly
 * live session with no stream and no way to get one back. A 30-second rule closed those. So
 * the stream is only one of three conditions - no stream, nothing on the wire for ten
 * minutes, and no tool call in flight - and the ten minutes is what actually decides. Claude
 * Code's blank tabs are therefore tidied up about ten minutes after it exits rather than
 * thirty seconds, which is the right way round: the other way ends sessions still in use.
 */
export const STREAM_LOSS_IDLE_MS = 10 * 60 * 1000;

// --- header hygiene -------------------------------------------------------

function bearerToken(header) {
  if (Array.isArray(header)) header = header[0];
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is not a secret: an attacker learns it from the daemon.json they cannot read.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- request bodies -------------------------------------------------------

class BodyTooLargeError extends Error {}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError(`request body over ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("the client aborted the request")));
  });
}

function messagesOf(body) {
  return Array.isArray(body) ? body : [body];
}

function initializeRequest(body) {
  return messagesOf(body).find(
    (message) => message !== null && typeof message === "object" && message.method === "initialize",
  );
}

// --- the daemon -----------------------------------------------------------

/**
 * `makeClient` and `now` exist for the tests: the first so a session's socket client can
 * be observed, the second so idle expiry can be driven by a fake clock rather than by
 * waiting a day.
 */
export function createDaemon({
  token,
  secret,
  env = process.env,
  now = () => Date.now(),
  makeClient,
  registry,
  onSessionServer,
  log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
} = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("the daemon needs the token from daemon.json");
  }
  if (typeof secret !== "string" || !/^[0-9a-f]{32,}$/.test(secret)) {
    throw new Error("the daemon needs the secret from daemon.json (run `node bin/install.js`)");
  }

  const sessions = new Map();
  /** What could not be derived about a session id: its labels and its tombstone. */
  const known = (registry ?? new SessionRegistry({ file: sessionsPath(env), secret, now })).load();
  /** One adoption per id, even if two requests for it arrive together. */
  const adopting = new Map();
  let fallbackCounter = 0;
  let closing = false;

  const registryKey = (id) => deriveRegistryKey(secret, id);
  const remember = (id) => known.get(registryKey(id));
  /**
   * What a session is called in the log. Never the session id: daemon.log is a file, and an id
   * plus daemon.json's secret derives that session's key, so writing ids down would put back
   * exactly the exposure that deriving keys removed. Eight hex characters of a one-way tag are
   * enough to follow one session through a log and tell two apart.
   */
  const tag = (id) => registryKey(id).slice(0, 8);

  const newClient =
    makeClient ??
    (({ name, agent, account, sessionKey }) =>
      new BridgeClient({
        socketPath: socketPath(env),
        // Derived from the MCP session id, never stored and never random: the same id gives
        // the same key after a restart, which is what hands a session its own tab group back,
        // and no file anywhere maps one to the other.
        sessionKey,
        name,
        agent,
        account,
      }));

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`request failed: ${error?.message ?? error}`);
      if (!res.headersSent) jsonError(res, 500, -32603, "Internal error");
      else res.end();
    });
  });

  function port() {
    const address = httpServer.address();
    return typeof address === "object" && address ? address.port : null;
  }

  function jsonError(res, status, code, message) {
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  function allowedHosts() {
    return [`127.0.0.1:${port()}`, `localhost:${port()}`];
  }

  async function handle(req, res) {
    const target = new URL(req.url ?? "/", "http://127.0.0.1");

    // Before routing, not per endpoint. /healthz used to skip both of these, which handed a
    // DNS-rebinding page this machine's pid, the socket path (and so the username) and the
    // daemon's liveness for free. A CLI never sends Origin; a browser always does. Refusing
    // it outright, and never answering with a CORS header, is what keeps a page the user
    // happens to be visiting from driving their browser through the daemon.
    if (req.headers.origin !== undefined) {
      jsonError(res, 403, -32000, "Origin header is not accepted");
      return;
    }
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    if (!host || !allowedHosts().includes(host)) {
      jsonError(res, 403, -32000, `Invalid Host header: ${host ?? "(none)"}`);
      return;
    }

    if (target.pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        jsonError(res, 405, -32000, "Method not allowed");
        return;
      }
      const body = JSON.stringify(health());
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (target.pathname !== "/mcp") {
      jsonError(res, 404, -32601, "Not found");
      return;
    }

    if (!tokensMatch(bearerToken(req.headers.authorization), token)) {
      jsonError(res, 401, -32000, "Unauthorized: a Bearer token from daemon.json is required");
      return;
    }

    const sessionId = Array.isArray(req.headers["mcp-session-id"])
      ? req.headers["mcp-session-id"][0]
      : req.headers["mcp-session-id"];

    let body;
    if (req.method === "POST") {
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          jsonError(res, 413, -32600, `Request body is over the ${MAX_BODY_BYTES} byte limit`);
          return;
        }
        throw error;
      }
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        jsonError(res, 400, -32700, "Parse error: Invalid JSON-RPC message");
        return;
      }
    }

    const initializing = req.method === "POST" ? initializeRequest(body) : undefined;
    // Anything that would make a *new* session is subject to the cap, and there are two such
    // paths: a plain initialize, and an initialize that still carries an old id. Checking only
    // the first let the second walk straight past it.
    const wouldStartSession = Boolean(initializing) && !sessions.has(sessionId ?? "");
    if (wouldStartSession && sessions.size >= MAX_LIVE_SESSIONS) {
      jsonError(res, 503, -32000, `The Browser Bridge daemon is already holding ${MAX_LIVE_SESSIONS} sessions`);
      return;
    }

    // An `initialize` that carries an id this daemon does not have is a client starting over,
    // not a session to adopt: an adopted transport is already initialized, so handing it one
    // would be a permanent 400. Give it a new session, and a new derived key with it.
    //
    // An id that *is* live is a different thing - a second initialize on a working session -
    // and it belongs to the transport, which refuses it. Starting a new session there would
    // fork the client in two and abandon the tab group it was using.
    if (sessionId && initializing && !sessions.has(sessionId)) {
      if (closing) {
        jsonError(res, 503, -32000, "The Browser Bridge daemon is shutting down");
        return;
      }
      log(`initialize carried a session id this daemon does not have; starting a new session`);
      await startSession(req, res, body, initializing);
      return;
    }

    if (sessionId) {
      let entry = sessions.get(sessionId);
      if (!entry) {
        if (closing) {
          jsonError(res, 503, -32000, "The Browser Bridge daemon is shutting down");
          return;
        }
        if (!VALID_SESSION_ID.test(sessionId)) {
          jsonError(res, 400, -32000, "Bad Request: Mcp-Session-Id is not a usable session id");
          return;
        }
        const remembered = remember(sessionId);
        // A session the client itself closed is over. Reviving it would take back the tab
        // group that DELETE released - the extension has already let it go - so this id is
        // dead until its tombstone is pruned.
        if (remembered?.endedBy === "client") {
          jsonError(res, 404, -32001, "Session not found");
          return;
        }
        if (sessions.size >= MAX_LIVE_SESSIONS) {
          jsonError(
            res,
            503,
            -32000,
            `The Browser Bridge daemon is already holding ${MAX_LIVE_SESSIONS} sessions`,
          );
          return;
        }
        // NOT a 404. The SDK's client - and the transport bundled in Claude Code - throws
        // `Session not found` on one and never clears its session id, so a 404 strands that
        // agent's browser access for good, and `node bin/install.js` restarts this daemon on
        // every landing. The id is adopted instead, and the registry gives it back the
        // sessionKey it had, which is what makes the extension hand back the same tab group.
        entry = await adoptOnce(req, sessionId);
      }
      await renameFromRequest(sessionId, entry, req);
      // Any request at all means the client is still there; the sweep reads this.
      entry.lastSeenAt = now();
      known.touch(registryKey(sessionId), entry.lastSeenAt);
      if (req.method === "GET") trackStream(entry, res);
      else entry.inFlight += 1;
      try {
        await entry.transport.handleRequest(req, res, body);
      } finally {
        // A session is never ended out from under a tool call, so the count has to come back
        // down even when the transport threw.
        if (req.method !== "GET") entry.inFlight -= 1;
      }
      return;
    }

    if (!initializing) {
      jsonError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return;
    }
    if (closing) {
      jsonError(res, 503, -32000, "The Browser Bridge daemon is shutting down");
      return;
    }
    await startSession(req, res, body, initializing);
  }

  // --- the client's event stream as a liveness signal ---------------------

  /**
   * Count one GET while it is open. Whether the SDK actually gave the client a stream is
   * only known once the response is finished: a GET it refuses (405 without an
   * `text/event-stream` Accept, 409 when a stream is already open) closes immediately with
   * that status, and must not make the session look like one that streams.
   */
  function trackStream(entry, res) {
    entry.openStreams += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      entry.openStreams -= 1;
      if (res.statusCode !== 200) return; // refused, so it was never a stream
      // Nothing is armed here. Whether this session should end is decided from its state by
      // the sweep, because a client may reopen the stream, or carry on without one.
      entry.streamed = true;
      if (entry.openStreams <= 0) entry.streamLostAt = now();
    };
    res.on("close", settle);
  }

  /**
   * Both clients send the X-Browser-Bridge-* headers on *every* request, not only on
   * initialize, so an adopted session can be named from the request in front of us. The
   * registry is the fallback for a client that stopped sending them, and the client's own
   * name from initialize is the last resort.
   */
  function identityFor(req, { initialize, remembered } = {}) {
    const agent = readHeaderValue(req.headers["x-browser-bridge-agent"], 40) ?? remembered?.agent ?? null;
    const account = readHeaderValue(req.headers["x-browser-bridge-account"]) ?? remembered?.account ?? null;
    let name = readHeaderValue(req.headers["x-browser-bridge-session"]) ?? remembered?.name ?? null;
    if (!name) {
      // Claude Code and Codex send different clientInfo names; whatever they send is
      // better than nothing, and the counter keeps two of them apart.
      const client = sanitizeHeaderValue(initialize?.params?.clientInfo?.name, 40) ?? "mcp client";
      name = `${client} #${++fallbackCounter}`;
    }
    return { name, agent, account };
  }

  /**
   * A session is named when it starts, but a session Keep could not name at launch (its
   * number was not ready) is named later: \`keep browser show\` leaves a name for its pane
   * that bin/headers.js sends from then on. The new name reaches the host, and the
   * extension retitles the group on the next call, so the tab group reads \`#405\` and the
   * console's browser view can find it.
   */
  async function renameFromRequest(id, entry, req) {
    const name = readHeaderValue(req.headers["x-browser-bridge-session"]);
    if (!name || name === entry.name) return;
    log(`session renamed ${tag(id)} ${JSON.stringify(entry.name)} -> ${JSON.stringify(name)}`);
    entry.name = name;
    known.put(registryKey(id), { name, agent: entry.agent, account: entry.account });
    try {
      await entry.client.rename?.(name);
    } catch (error) {
      log(`could not tell the host about the rename: ${error?.message ?? error}`);
    }
  }

  function newEntry(identity, client) {
    return {
      ...identity,
      client,
      transport: null,
      id: null,
      lastSeenAt: now(),
      openStreams: 0,
      streamed: false,
      // When the last stream went away. The ten-minute rule runs from the later of this and
      // the last request: a session that had been quiet for half an hour with its stream open
      // was otherwise swept the moment the stream dropped, having been given no grace at all.
      streamLostAt: 0,
      inFlight: 0,
    };
  }

  /**
   * A transport bound to a session id the daemon did not hand out, in the state the SDK
   * leaves one in after a successful initialize.
   *
   * This reaches into the SDK: `sessionId` and `_initialized` on the inner web-standard
   * transport are plain instance properties (checked against
   * `@modelcontextprotocol/sdk` **1.30.0**, `server/webStandardStreamableHttp.js` -
   * `validateSession` reads exactly those two), and there is no public way to say "this
   * transport already belongs to session X". If a future SDK makes them private this throws
   * at startup rather than silently 404ing, which is the failure mode worth having: the
   * alternative is stranding every agent on the machine.
   */
  function adoptTransport(id) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(),
      onsessionclosed: (closed) => {
        // `by: "client"` exactly as for a session the daemon started: an adopted session's
        // DELETE is just as final, and without it the id could be adopted a second time and
        // take back the tab group that DELETE had released.
        void endSession(closed, "client closed the session", { by: "client" });
      },
    });
    const inner = transport._webStandardTransport;
    if (!inner || !("_initialized" in inner)) {
      throw new Error("the MCP SDK's streamable-HTTP transport has changed shape; adoption needs updating");
    }
    inner.sessionId = id;
    inner._initialized = true;
    return transport;
  }

  /**
   * Take over a session id the daemon does not know: after a restart, or after this session
   * was ended early. The sessionKey comes from the registry when it has one - live entry or
   * tombstone - because that is what the extension keys a tab group by, so the agent gets
   * back the tabs it was using instead of a second group beside them.
   */
  async function adoptSession(req, id) {
    const remembered = remember(id);
    const identity = identityFor(req, { remembered });
    // Derived from the id, so there is nothing to look up and nothing that could be handed to
    // the wrong caller: whoever holds the id gets the key for that id, and only that one.
    const client = newClient({ ...identity, sessionKey: deriveSessionKey(secret, id) });
    const entry = newEntry(identity, client);
    entry.id = id;
    entry.transport = adoptTransport(id);
    entry.transport.onerror = (error) => log(`transport error: ${error?.message ?? error}`);

    const server = createSessionServer({ ...identity, client, env });
    // Register before the first await that could let another request in. `adoptOnce` holds the
    // lock, but nothing below here may await before `sessions.set`: two adoptions of one id
    // would mean two socket clients on one tab group.
    sessions.set(id, entry);
    known.put(registryKey(id), identity);
    log(
      `session adopted ${tag(id)} name=${JSON.stringify(identity.name)} ` +
        `labels=${remembered ? (remembered.ended ? "remembered (ended)" : "remembered") : "from the request"} ` +
        `(${sessions.size} open)`,
    );
    await server.connect(entry.transport);
    return entry;
  }

  /**
   * One adoption per id. Two requests for the same unknown id can arrive together on separate
   * connections - an agent that resumes with a tool call while its event stream reconnects does
   * exactly that - and each would otherwise build a whole session of its own.
   */
  function adoptOnce(req, id) {
    const running = adopting.get(id);
    if (running) return running;
    const started = adoptSession(req, id).finally(() => adopting.delete(id));
    adopting.set(id, started);
    return started;
  }

  async function startSession(req, res, body, initialize) {
    const identity = identityFor(req, { initialize });
    // The id is minted here rather than inside the transport, because the session key is
    // derived from it and the client needs the key before the transport answers.
    const id = randomUUID();
    const client = newClient({ ...identity, sessionKey: deriveSessionKey(secret, id) });
    const entry = newEntry(identity, client);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableDnsRebindingProtection: true,
      // The bound port, not the configured one: the tests listen on port 0.
      allowedHosts: allowedHosts(),
      onsessioninitialized: async (started) => {
        entry.id = started;
        sessions.set(started, entry);
        known.put(registryKey(started), identity);
        log(`session start ${tag(started)} name=${JSON.stringify(identity.name)} agent=${identity.agent ?? "-"} account=${identity.account ?? "-"} (${sessions.size} open)`);
        // A hook for the tests, and the only way to reach the failure path below: the session
        // is registered from here, before its initialize response goes out, and nothing else
        // in between throws.
        if (onSessionServer) await onSessionServer({ id: started, transport, server });
      },
      onsessionclosed: (closed) => {
        // The client said DELETE: close its socket so the host emits session_closed, exactly
        // as a stdio server's `bye` on exit did. `by: "client"` is what makes that final:
        // the group has been released and this id must not bring it back.
        void endSession(closed, "client closed the session", { by: "client" });
      },
    });
    entry.transport = transport;
    transport.onerror = (error) => log(`transport error: ${error?.message ?? error}`);

    const server = createSessionServer({ ...identity, client, env });
    await server.connect(transport);

    try {
      await transport.handleRequest(req, res, body);
    } catch (error) {
      // onsessioninitialized fires before the response is written, so the session may
      // already be registered when this throws - and then nothing else would ever close it.
      if (entry.id) await endSession(entry.id, `its initialize failed: ${error?.message ?? error}`);
      else {
        await closeQuietly(client);
        await closeQuietly(transport);
      }
      throw error;
    }
    // The transport refused the request (a bad Host header, a second initialize) and never
    // called onsessioninitialized, so nothing is registered and nothing would close this.
    if (!entry.id) {
      await closeQuietly(client);
      await closeQuietly(transport);
      return;
    }
    // Registered, but the initialize did not come back 200: something between registering the
    // session and answering went wrong, and the error did not reach us as a throw (the Node
    // wrapper turns one into a 500 of its own). Either way this session has no client that
    // knows about it, so nothing would ever close it.
    if (res.statusCode >= 400) {
      await endSession(entry.id, `its initialize answered ${res.statusCode}`);
    }
  }

  async function closeQuietly(closable) {
    try {
      await closable.close();
    } catch {
      // A close that fails has nothing left worth reporting.
    }
  }

  async function endSession(id, reason, { by = "daemon" } = {}) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    // A tombstone, not a deletion: an id the *daemon* ended may well come back - a client that
    // was merely quiet, or a restart - and it should find its own tabs again. An id the
    // *client* ended is over; see the 404 in `handle`.
    known.end(registryKey(id), { by });
    // `bye` first: the host drops the session and the extension keeps the tabs, so a
    // session that comes back with the same name lands in the group it left.
    await closeQuietly(entry.client);
    await closeQuietly(entry.transport);
    log(`session end ${tag(id)} name=${JSON.stringify(entry.name)} - ${reason} (${sessions.size} open)`);
  }

  /**
   * Idle expiry, and the end of a grace period. Tabs stay either way; the extension's
   * ended-session revival covers a return.
   *
   * A session that has never had an event stream can only go by the clock: there is no
   * signal to miss. One that has had a stream and has none now, and has not come back
   * within the grace, is a client that went away without saying so.
   */
  async function sweep(at = now()) {
    const done = [];
    for (const [id, entry] of sessions) {
      // An open event stream is direct evidence the client is still there, which is what the
      // idle clock was only ever guessing at. Expiring one of those would cost a live Claude
      // Code session its tab group for the crime of not using the browser all day.
      if (entry.openStreams > 0) continue;
      // And a session is never ended out from under a call it is still serving.
      if (entry.inFlight > 0) continue;
      if (at - entry.lastSeenAt > IDLE_TIMEOUT_MS) done.push([id, "idle for 24 hours"]);
      // Had a stream, has none now, and ten minutes have passed since the later of its last
      // request and the moment the stream went. Any one of those on its own is normal: the
      // SDK's client gives up reconnecting after two tries, and a session can be quiet for an
      // afternoon with its stream open and then carry on - which is why the stream closing
      // starts a clock of its own rather than being judged against an old request.
      else if (entry.streamed && at - Math.max(entry.lastSeenAt, entry.streamLostAt) >= STREAM_LOSS_IDLE_MS) {
        done.push([id, `no event stream and nothing on the wire for ${STREAM_LOSS_IDLE_MS / 60000} minutes`]);
      }
    }
    for (const [id, reason] of done) await endSession(id, reason);
    // Every session still here is in use, whatever its last request looked like, so its entry
    // must not be pruned out from under it.
    for (const id of sessions.keys()) known.touch(registryKey(id), at);
    known.prune(at);
    return done.map(([id]) => id);
  }

  /**
   * What the installer waits for, and the one thing that answers without a token. It
   * never opens a socket of its own: a probe that said `hello` would show up in the
   * extension as a session with a tab group.
   */
  function health() {
    let status = null;
    for (const entry of sessions.values()) {
      if (entry.client.lastHostStatus) status = entry.client.lastHostStatus;
    }
    return {
      ok: true,
      pid: process.pid,
      port: port(),
      sessions: sessions.size,
      streams: [...sessions.values()].reduce((total, entry) => total + entry.openStreams, 0),
      remembered: known.size,
      host: {
        socket: socketPath(env),
        connected: [...sessions.values()].filter((entry) => entry.client.connected).length,
        hostPid: status?.hostPid ?? null,
        extensionConnected: status?.extensionConnected ?? null,
        extensionVersion: status?.extensionVersion ?? null,
      },
    };
  }

  let sweepTimer = null;

  function listen(requestedPort) {
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(requestedPort, "127.0.0.1", () => {
        httpServer.off("error", reject);
        sweepTimer = setInterval(() => {
          void sweep();
        }, SWEEP_INTERVAL_MS);
        sweepTimer.unref();
        log(`listening on 127.0.0.1:${port()} (pid ${process.pid}, socket ${socketPath(env)})`);
        resolve(port());
      });
    });
  }

  /**
   * Close every session's socket cleanly, then stop listening.
   *
   * In parallel, and with a short deadline. One `bye` at a time, each able to wait out the
   * client's 100-second request timeout, meant a single wedged host was enough for launchd
   * to SIGKILL the daemon before any session had said goodbye at all - so the extension kept
   * every tab group as live.
   */
  async function shutdown(reason = "shutting down") {
    closing = true;
    if (sweepTimer) clearInterval(sweepTimer);
    await Promise.allSettled([...sessions.keys()].map((id) => endSession(id, reason)));
    known.close();
    await new Promise((resolve) => httpServer.close(() => resolve()));
    log(`stopped: ${reason}`);
  }

  return {
    httpServer,
    listen,
    shutdown,
    sweep,
    endSession,
    adoptSession,
    health,
    sessions,
    registry: known,
    port,
    log,
  };
}

// --- entry point ----------------------------------------------------------

export async function main(env = process.env) {
  const config = readDaemonConfig(env);
  if (!config) {
    process.stderr.write(
      `Browser Bridge daemon: no usable ${env.BROWSER_BRIDGE_RUNTIME_DIR ?? "~/Library/Application Support/BrowserBridge"}/daemon.json.\n` +
        "Run `node bin/install.js` to write one (it creates the port and the token).\n",
    );
    process.exitCode = 1;
    return null;
  }
  const requested = env.BROWSER_BRIDGE_DAEMON_PORT
    ? Number(env.BROWSER_BRIDGE_DAEMON_PORT)
    : config.port;
  if (!config.secret) {
    process.stderr.write(
      "Browser Bridge daemon: daemon.json has no `secret`, which is what session keys are derived from.\n" +
        "Run `node bin/install.js` to add one (it keeps the existing token).\n",
    );
    process.exitCode = 1;
    return null;
  }
  const daemon = createDaemon({ token: config.token, secret: config.secret, env });
  try {
    await daemon.listen(Number.isInteger(requested) ? requested : DEFAULT_DAEMON_PORT);
  } catch (error) {
    // Another daemon already owns the port. launchd's ThrottleInterval keeps the retry
    // loop slow; exiting non-zero is the honest answer.
    process.stderr.write(`Browser Bridge daemon: could not listen - ${error.message}\n`);
    process.exitCode = 1;
    return null;
  }

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    daemon.shutdown(`${signal} received`).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  return daemon;
}

if (isMainModule(import.meta.url)) {
  await main();
}
