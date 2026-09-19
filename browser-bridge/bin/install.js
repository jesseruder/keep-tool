#!/usr/bin/env node
// Registers the native messaging host with Edge (and Chrome on request), keeps the shared
// MCP daemon alive through launchd, and points every Claude config directory and Codex
// home on this machine at it over loopback HTTP.
//
//   node bin/install.js [--browser edge|chrome] [--chrome-too] [--stdio]
//                       [--rotate-token] [--dry-run] [--uninstall]
//
// Nothing here is clever on purpose: --dry-run prints every file it would write, every
// config edit it would make and every command it would run, so the whole thing can be
// read before it touches a browser profile.
//
// The launchd job runs *this checkout's* mcp/daemon.js, so a landing does not reach
// sessions until the daemon has been reloaded. Re-running the installer is what does it.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DAEMON_LABEL,
  DEFAULT_DAEMON_PORT,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  HOST_NAME,
  daemonConfigPath,
  daemonLogPath,
  daemonUrl,
  launcherPath,
  readDaemonConfig,
  runtimeDir,
} from "../host/protocol.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_FALLBACK = "/Users/jesseruder/.local/bin/codex";
const LAUNCHCTL = "/bin/launchctl";
/** How long `launchctl bootstrap` gets to bring the daemon up before we complain. */
const HEALTH_TIMEOUT_MS = 10_000;

const BROWSER_DIRS = {
  edge: ["Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"],
  chrome: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
};

export function parseArgs(argv) {
  const options = {
    browsers: ["edge"],
    dryRun: false,
    uninstall: false,
    stdio: false,
    rotateToken: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--stdio") options.stdio = true;
    else if (arg === "--rotate-token") options.rotateToken = true;
    else if (arg === "--chrome-too") options.browsers = ["edge", "chrome"];
    else if (arg === "--browser") {
      const value = argv[++index];
      if (!BROWSER_DIRS[value]) throw new Error(`--browser must be edge or chrome, not ${value}`);
      options.browsers = [value];
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function hostManifestPath(browser, env = process.env) {
  return path.join(env.HOME, ...BROWSER_DIRS[browser], `${HOST_NAME}.json`);
}

export function hostManifest(env = process.env) {
  return {
    name: HOST_NAME,
    description: "Browser Bridge: local agent sessions drive this browser",
    path: launcherPath(env),
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
}

/** POSIX single-quoting: everything is literal except the quote itself. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * A command line for a config field rather than for a shell script. Both clients run the
 * helper through a shell (Codex `sh -c`, Claude Code `shell: true`), so quoting a path
 * that has a space in it works; a path that needs no quoting gets none, which also keeps
 * it correct for any client that splits on whitespace instead.
 */
export function commandLine(...parts) {
  return parts.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : shellQuote(part))).join(" ");
}

export function launcherScript(nodePath, projectDir = PROJECT_DIR) {
  // Edge launches native hosts with a minimal environment: no PATH, no nvm shims, so
  // both paths are absolute and there is nothing to resolve at run time. They are also
  // quoted: a checkout under a path with a space would otherwise become two arguments.
  const script = path.join(projectDir, "host", "native-host.js");
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(script)} "$@"\n`;
}

// --- the shared daemon ----------------------------------------------------

/**
 * What daemon.json holds: the port, the bearer `token` every agent sends, and the `secret`
 * session keys are derived from.
 *
 * Both are kept if they are already there. The token is in every registration's reach and
 * rotating it under a running session would take that session's browser away for no reason;
 * rotating the secret would re-derive every session key, which means every live session loses
 * its tab group. `--rotate-token` does both deliberately. An install from before the secret
 * existed gains one without its token changing.
 */
export function daemonSettings(options, env = process.env) {
  const existing = readDaemonConfig(env);
  const rotate = Boolean(options.rotateToken);
  const token = !rotate && existing?.token ? existing.token : randomBytes(32).toString("hex");
  const secret = !rotate && existing?.secret ? existing.secret : randomBytes(32).toString("hex");
  return {
    port: existing?.port ?? DEFAULT_DAEMON_PORT,
    token,
    secret,
    // Write only when something actually changed, so a re-run does not churn the file.
    fresh: rotate || existing?.token !== token || existing?.secret !== secret,
  };
}

export function daemonPlistPath(env = process.env) {
  return path.join(env.HOME, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
}

function plistString(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * A launchd agent, not a login item: RunAtLoad brings it up with the user session and
 * KeepAlive brings it back after a crash, an `npm install` or a landing that changed the
 * code out from under it. ThrottleInterval keeps a daemon that cannot bind its port from
 * spinning. stdout and stderr both go to daemon.log; the daemon logs one line per
 * session and never logs a tool's arguments.
 */
export function daemonPlist(nodePath, env = process.env, projectDir = PROJECT_DIR) {
  const log = daemonLogPath(env);
  const entries = [
    ["Label", DAEMON_LABEL],
    ["ProgramArguments", [nodePath, path.join(projectDir, "mcp", "daemon.js")]],
    ["RunAtLoad", true],
    ["KeepAlive", true],
    ["ThrottleInterval", 5],
    ["WorkingDirectory", projectDir],
    ["StandardOutPath", log],
    ["StandardErrorPath", log],
  ];
  const body = entries
    .map(([key, value]) => {
      let rendered;
      if (typeof value === "boolean") rendered = `  <${value}/>`;
      else if (typeof value === "number") rendered = `  <integer>${value}</integer>`;
      else if (Array.isArray(value)) {
        rendered = ["  <array>", ...value.map((item) => `    <string>${plistString(item)}</string>`), "  </array>"].join(
          "\n",
        );
      } else rendered = `  <string>${plistString(value)}</string>`;
      return `  <key>${key}</key>\n${rendered}`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

function which(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  const found = result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
  return found || null;
}

export function claudeConfigDirs(env = process.env) {
  const home = env.HOME;
  const dirs = [];
  const base = path.join(home, ".claude");
  // The default config directory keeps its global config at ~/.claude.json, and
  // `claude mcp add` finds that itself when CLAUDE_CONFIG_DIR is unset.
  if (fs.existsSync(base)) dirs.push({ dir: base, useEnv: false });
  let entries = [];
  try {
    entries = fs.readdirSync(home);
  } catch {
    entries = [];
  }
  for (const entry of entries.sort()) {
    if (!entry.startsWith(".claude-")) continue;
    const dir = path.join(home, entry);
    if (!fs.existsSync(path.join(dir, ".claude.json"))) continue;
    dirs.push({ dir, useEnv: true });
  }
  return dirs;
}

export function codexHomes(env = process.env) {
  return [path.join(env.HOME, ".codex"), path.join(env.HOME, ".codex-secondary")].filter((dir) =>
    fs.existsSync(dir),
  );
}

// --- editing the agents' own config files ---------------------------------
//
// `claude mcp add` and `codex mcp add` can register an HTTP server but neither has a flag
// for the headers helper, so the helper is written into the config file directly. Both
// edits are surgical: the Claude one replaces `mcpServers.browser` and keeps every other
// key (that file also holds project history and onboarding state), and the Codex one
// replaces the `[mcp_servers.browser]` table and leaves the rest of the TOML byte for
// byte. Both write a `.bak` first. A live session that rewrites its config after this
// runs would drop the entry, which is why the installer reports what it wrote and
// re-running it is cheap.

/**
 * The direct edit of a Claude config, used only when `claude mcp add-json` cannot be run
 * or refuses. `entry` null means remove.
 */
export function claudeEdit(label, dir, env, entry) {
  const file = claudeConfigFile(dir, env);
  return {
    label,
    path: file,
    createIfMissing: entry !== null,
    initial: "{}\n",
    mode: 0o600,
    describe: entry ? `set mcpServers.browser to ${JSON.stringify(entry)}` : "remove mcpServers.browser",
    apply: (text) => (entry ? withClaudeServer(text, entry) : withoutClaudeServer(text)),
    fallback: entry ? claudeFallback(entry, dir, env) : null,
  };
}

/** The default config directory keeps its global config at ~/.claude.json. */
export function claudeConfigFile(dir, env = process.env) {
  return dir === path.join(env.HOME, ".claude")
    ? path.join(env.HOME, ".claude.json")
    : path.join(dir, ".claude.json");
}

/**
 * The field names are the installed clients', not a guess: `headersHelper` on an http MCP
 * server entry for Claude Code, `http_headers_helper` on a `url` server for Codex. Both
 * take one command-line string and expect one JSON object of headers on its stdout, which
 * is what `bin/headers.js` prints.
 *
 * Codex (codex-cli 0.154.0) runs it through `sh -c`, gives it 10 s, caps the output at
 * 64 KiB and refuses a reserved header name (`accept`, `content-type`, `origin`, ... -
 * `authorization` is allowed), refuses an empty string, and accepts it only on a url
 * server with no `environment_id`. Neither CLI has a flag for it, so both are written into
 * the config file.
 */
export const CLAUDE_HELPER_FIELD = "headersHelper";
export const CODEX_HELPER_FIELD = "http_headers_helper";
export const CODEX_TABLE = "mcp_servers.browser";

export function claudeHttpEntry(url, helperCommand) {
  return { type: "http", url, [CLAUDE_HELPER_FIELD]: helperCommand };
}

export function claudeStdioEntry(nodePath, serverPath) {
  return { type: "stdio", command: nodePath, args: [serverPath] };
}

/**
 * `url` makes it a streamable_http server, which is what `http_headers_helper` requires
 * (`http_headers_helper is not supported for stdio`), so the old `command`/`args` keys have
 * to go - which the table replacement does. The two timeouts are generous on purpose: the
 * host's own per-request budget is 90 s and the socket client's is 100 s, so a slow
 * navigate must not be cut off by the agent first.
 *
 * Codex runs the helper *without* the session's environment (verified live: a Codex session
 * arrived as `codex-mcp-client #2` with no agent and no account, while the token came
 * through fine), so the session name cannot come from the helper here. `env_http_headers`
 * maps a header to an environment variable that **Codex itself** reads, which is where the
 * name and the account come from; the agent is a constant for a Codex home, so it is a
 * static header. The token stays the helper's alone: it is the one value that is not in the
 * environment, and keeping it out of these two tables means there is no header both sides
 * set and so no merge order to depend on.
 */
export function codexHttpTable(url, helperCommand) {
  return codexTable(CODEX_TABLE, {
    url,
    [CODEX_HELPER_FIELD]: helperCommand,
    env_http_headers: {
      "X-Browser-Bridge-Session": "BROWSER_BRIDGE_SESSION_NAME",
      "X-Browser-Bridge-Account": "KEEP_AGENT_ACCOUNT_ID",
    },
    http_headers: { "X-Browser-Bridge-Agent": "codex" },
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
  });
}

export function codexStdioTable(nodePath, serverPath) {
  return codexTable(CODEX_TABLE, { command: nodePath, args: [serverPath] });
}

/** Returns the new file text, or null when nothing has to change. */
export function withClaudeServer(text, entry) {
  const config = text.trim() ? JSON.parse(text) : {};
  const servers = config.mcpServers ?? {};
  if (JSON.stringify(servers.browser) === JSON.stringify(entry)) return null;
  config.mcpServers = { ...servers, browser: entry };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function withoutClaudeServer(text) {
  const config = text.trim() ? JSON.parse(text) : {};
  if (!config.mcpServers || config.mcpServers.browser === undefined) return null;
  const servers = { ...config.mcpServers };
  delete servers.browser;
  config.mcpServers = servers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "boolean") return String(value);
  // The only numbers this file writes are Codex's timeouts, which are seconds as a float.
  // TOML tells an integer from a float, so `20` and `20.0` are not the same token there.
  if (typeof value === "number") return Number.isInteger(value) ? value.toFixed(1) : String(value);
  // An inline table, not a sub-table: `[mcp_servers.browser.http_headers]` would be a
  // table of its own, and the table splice below stops at the next `[`, so a sub-table
  // written here would be orphaned by the next run instead of replaced.
  if (value !== null && typeof value === "object") {
    const pairs = Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)} = ${tomlValue(inner)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  return JSON.stringify(String(value));
}

export function codexTable(name, fields) {
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Splice one table into a TOML file, replacing it if it is already there. The table's own
 * lines are the only ones touched: a TOML table runs until the next line that opens
 * another table, so the boundaries are found by reading, not by parsing the whole file.
 */
/**
 * A table header, matched the way TOML actually writes one. Whitespace inside the brackets
 * and a trailing comment are both legal, and matching the line by its exact text missed
 * them - so the table was appended a second time and Codex then refused the whole file for
 * a duplicate key.
 */
function tomlHeaderPattern(nameRegex) {
  return new RegExp(`^\\s*\\[\\s*${nameRegex}\\s*\\]\\s*(#.*)?$`);
}

function escapeForRegex(name) {
  return name.replaceAll(".", "\\.");
}

/**
 * Sub-tables of ours that are the *user's* to keep. `[mcp_servers.browser.tools.<tool>]` is
 * per-tool approval settings somebody typed on purpose, and it cannot collide with the inline
 * keys this installer writes, so it is carried across a replacement rather than swept away.
 */
const PRESERVED_SUB_TABLE = /^\s*\[\s*mcp_servers\.browser\.tools(\.[^\]]*)?\s*\]/;

/**
 * Where a table starts, where its own lines end, and which of its sub-tables were in that
 * range. The range covers every `[<name>.<sub>]` sub-table that follows, because those belong
 * to it: a leftover `[mcp_servers.browser.http_headers]` sitting after a replaced table would
 * collide with the inline `http_headers` the new one declares, and a duplicate key makes the
 * file unreadable.
 */
function tomlTableRange(lines, name) {
  const header = tomlHeaderPattern(escapeForRegex(name));
  const sub = tomlHeaderPattern(`${escapeForRegex(name)}\\.[^\\]]+`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const subTables = [];
  let end = start + 1;
  for (;;) {
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    if (end < lines.length && sub.test(lines[end])) {
      const from = end;
      end += 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      subTables.push({ header: lines[from].trim(), lines: lines.slice(from, end) });
      continue;
    }
    break;
  }
  return { start, end, subTables };
}

/** What a replacement or a removal would take with it, for the installer to report. */
export function tomlSubTables(text, name) {
  const range = tomlTableRange(text.split("\n"), name);
  return range ? range.subTables.map((sub) => sub.header) : [];
}

export function withTomlTable(text, name, table) {
  const lines = text.split("\n");
  const range = tomlTableRange(lines, name);
  if (range === null) {
    const padded = text === "" || text.endsWith("\n\n") ? text : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
    const next = `${padded}${table}`;
    return next === text ? null : next;
  }
  const { start, subTables } = range;
  let { end } = range;
  // The blank lines before whatever comes next (or the file's trailing newline) are not
  // part of this table. Leaving them where they are is what makes a second run a no-op.
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  // Anything under `.tools` is the user's, so it is re-emitted after the new table instead of
  // being swept up with the header tables we own.
  const kept = [];
  for (const sub of subTables) {
    if (!PRESERVED_SUB_TABLE.test(sub.header)) continue;
    const body = [...sub.lines];
    while (body.length > 0 && body.at(-1).trim() === "") body.pop();
    kept.push("", ...body);
  }
  const replacement = [
    ...lines.slice(0, start),
    ...table.replace(/\n$/, "").split("\n"),
    ...kept,
    ...lines.slice(end),
  ];
  const next = replacement.join("\n");
  return next === text ? null : next;
}

/** Drop a table, its sub-tables and its body, leaving the rest of the file alone. */
export function withoutTomlTable(text, name) {
  const lines = text.split("\n");
  const range = tomlTableRange(lines, name);
  if (range === null) return null;
  let end = range.end;
  // Swallow the blank line the table used to be separated by, not the next table's.
  while (end < lines.length && lines[end].trim() === "") end++;
  return [...lines.slice(0, range.start), ...lines.slice(end)].join("\n");
}

export function buildPlan(options, env = process.env, projectDir = PROJECT_DIR) {
  const nodePath = process.execPath;
  const serverPath = path.join(projectDir, "mcp", "server.js");
  const daemonPath = path.join(projectDir, "mcp", "daemon.js");
  const helperCommand = commandLine(nodePath, path.join(projectDir, "bin", "headers.js"));
  const files = [];
  const removals = [];
  const commands = [];
  const edits = [];
  // --stdio is the old shape exactly: a process per session, no daemon, no launchd job.
  const daemon = options.uninstall || options.stdio ? null : daemonSettings(options, env);
  const url = daemon ? daemonUrl(daemon.port) : null;

  if (options.stdio && !options.uninstall) {
    // Keep the launcher and the browser manifests - the extension still needs them - but the
    // launchd job and its plist go, because nothing is registered against the daemon.
    removals.push(daemonPlistPath(env));
  }

  if (options.uninstall) {
    removals.push(launcherPath(env));
    // Always both browsers: an install that once used --chrome-too must not leave
    // Chrome pointing at a launcher this run is deleting.
    for (const browser of Object.keys(BROWSER_DIRS)) removals.push(hostManifestPath(browser, env));
    // daemon.json stays: it holds the token, and a reinstall must not invalidate the
    // registrations of sessions that are still running.
    removals.push(daemonPlistPath(env));
  } else {
    files.push({
      path: launcherPath(env),
      content: launcherScript(nodePath, projectDir),
      mode: 0o700,
    });
    for (const browser of options.browsers) {
      files.push({
        path: hostManifestPath(browser, env),
        content: `${JSON.stringify(hostManifest(env), null, 2)}\n`,
        mode: 0o644,
      });
    }
  }

  if (daemon) {
    if (daemon.fresh) {
      files.push({
        path: daemonConfigPath(env),
        content: `${JSON.stringify({ port: daemon.port, token: daemon.token, secret: daemon.secret }, null, 2)}\n`,
        mode: 0o600,
        // Neither of these may reach a terminal or a log: the token drives the browser and the
        // secret derives every session's key.
        display:
          `{ "port": ${daemon.port}, "token": "<32 random bytes, hex>", ` +
          `"secret": "<32 random bytes, hex>" }`,
      });
    }
    files.push({
      path: daemonPlistPath(env),
      content: daemonPlist(nodePath, env, projectDir),
      mode: 0o644,
    });
  }

  // --stdio has to take the job out too: leaving it loaded would keep a daemon listening on
  // the port with nothing registered against it, and the next landing would restart it.
  const launchd =
    options.uninstall || options.stdio || daemon
      ? {
          uid: typeof process.getuid === "function" ? process.getuid() : 501,
          label: DAEMON_LABEL,
          plist: daemonPlistPath(env),
          uninstall: Boolean(options.uninstall || options.stdio),
          // Read before anything is written: the point of knowing is to decide whether the
          // job can be restarted in place instead of torn down and put back.
          plistUnchanged: daemon
            ? readIfPresent(daemonPlistPath(env)) === daemonPlist(nodePath, env, projectDir)
            : false,
        }
      : null;

  const claudeBin = which("claude");
  for (const { dir, useEnv } of claudeConfigDirs(env)) {
    const label = `claude (${path.basename(dir)})`;
    // A session started under another config dir inherits CLAUDE_CONFIG_DIR, and the
    // default registration would land there instead of in ~/.claude.json.
    const commandEnv = useEnv ? { CLAUDE_CONFIG_DIR: dir } : { CLAUDE_CONFIG_DIR: null };
    const entry = options.stdio
      ? claudeStdioEntry(nodePath, serverPath)
      : claudeHttpEntry(url, helperCommand);
    // Only used when the CLI is missing or refuses; see claudeEdit's comment.
    const edit = claudeEdit(label, dir, env, options.uninstall ? null : entry);
    const remove = {
      label,
      bin: claudeBin,
      name: "claude",
      args: ["mcp", "remove", "--scope", "user", "browser"],
      env: commandEnv,
      fallback: claudeFallback(entry, dir, env),
    };
    // `mcp add` refuses to overwrite, so reinstalling after a move would keep the old
    // path. Remove first and ignore the failure when there was nothing registered.
    if (options.uninstall) {
      commands.push({ ...remove, orEdit: edit });
      continue;
    }
    commands.push({ ...remove, optional: true });
    commands.push({
      ...remove,
      // `mcp add` has no flag for headersHelper (only --transport and --header), but
      // `mcp add-json` takes the whole entry, so the CLI still owns the write. That
      // matters: live sessions rewrite .claude.json, and editing it from here would race
      // them, so the direct edit is the fallback and not the first choice.
      args: ["mcp", "add-json", "--scope", "user", "browser", JSON.stringify(entry)],
      optional: false,
      orEdit: edit,
    });
  }

  const codexBin = options.stdio ? which("codex") ?? (fs.existsSync(CODEX_FALLBACK) ? CODEX_FALLBACK : null) : null;
  for (const home of codexHomes(env)) {
    const label = `codex (${path.basename(home)})`;
    if (options.stdio) {
      const remove = {
        label,
        bin: codexBin,
        name: "codex",
        args: ["mcp", "remove", "browser"],
        env: { CODEX_HOME: home },
        fallback: codexFallback(codexStdioTable(nodePath, serverPath), home),
      };
      commands.push({ ...remove, optional: true });
      commands.push({
        ...remove,
        args: ["mcp", "add", "browser", "--", nodePath, serverPath],
        optional: false,
      });
      continue;
    }
    const table = options.uninstall ? null : codexHttpTable(url, helperCommand);
    edits.push({
      label,
      path: path.join(home, "config.toml"),
      createIfMissing: !options.uninstall,
      initial: "",
      mode: 0o600,
      describe: table ? `set [${CODEX_TABLE}] to the daemon's url` : `remove [${CODEX_TABLE}]`,
      preview: table,
      apply: (text) => (table ? withTomlTable(text, CODEX_TABLE, table) : withoutTomlTable(text, CODEX_TABLE)),
      dropped: (text) =>
        tomlSubTables(text, CODEX_TABLE).filter((header) => table === null || !/\.tools\b/.test(header)),
      fallback: table ? codexFallback(table, home) : null,
    });
  }

  return {
    files,
    removals,
    commands,
    edits,
    launchd,
    nodePath,
    serverPath,
    daemonPath,
    helperCommand,
    daemon,
    url,
  };
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// --- talking to launchd ---------------------------------------------------
//
// `launchctl bootout` returns before the job is actually gone, and a `bootstrap` inside
// that window fails with "Bootstrap failed: 5: Input/output error" - which is how a
// re-install once left the daemon down while the installer reported success. So: restart
// in place when nothing about the job has changed, and otherwise wait for the teardown to
// finish before putting it back, with retries, and never claim success without checking.

/** How long launchd gets to finish removing a job after bootout returns. */
const BOOTOUT_WAIT_MS = 10_000;
const BOOTOUT_POLL_MS = 250;
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 1_000;

function launchctlCommand(label, args, { quiet = false } = {}) {
  return { label, bin: LAUNCHCTL, name: "launchctl", args, env: {}, optional: true, quiet };
}

export function launchdCommands({ uid, label, plist }) {
  return {
    print: launchctlCommand("launchctl print", ["print", `gui/${uid}/${label}`], { quiet: true }),
    kickstart: launchctlCommand("launchctl kickstart", ["kickstart", "-k", `gui/${uid}/${label}`]),
    bootout: launchctlCommand("launchctl bootout", ["bootout", `gui/${uid}/${label}`]),
    bootstrap: launchctlCommand("launchctl bootstrap", ["bootstrap", `gui/${uid}`, plist]),
  };
}

/**
 * Bring the launchd job to the state the plan asks for. Returns `{loaded, how}`; `loaded`
 * is what the caller reports on, and it is read back from launchd rather than inferred
 * from an exit code.
 */
export async function reloadDaemon(launchd, { run, sleep, write = (text) => process.stdout.write(text) }) {
  const commands = launchdCommands(launchd);
  const isLoaded = () => run(commands.print) === 0;

  if (launchd.uninstall) {
    // A job that is not loaded is the normal state after a first uninstall, or after a
    // reboot with the plist already gone. Nothing to do, and nothing to complain about.
    if (!isLoaded()) {
      write(`${launchd.label} is not loaded; nothing to boot out\n`);
      return { loaded: false, how: "already gone" };
    }
    run(commands.bootout);
    await waitForGone(commands, { run, sleep });
    return { loaded: isLoaded(), how: "booted out" };
  }

  if (launchd.plistUnchanged && isLoaded()) {
    // Same plist, same job: restarting in place skips the teardown race entirely, which is
    // the common case (a landing changes the code the job runs, not the job).
    write(`${launchd.label} is loaded and its plist is unchanged; restarting it in place\n`);
    if (run(commands.kickstart) === 0) return { loaded: isLoaded(), how: "kickstarted" };
    write("kickstart failed; falling back to a full reload\n");
  }

  if (isLoaded()) {
    run(commands.bootout);
    if (!(await waitForGone(commands, { run, sleep }))) {
      write(`${launchd.label} is still loaded ${BOOTOUT_WAIT_MS / 1000}s after bootout; bootstrapping anyway\n`);
    }
  }

  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    if (run(commands.bootstrap) === 0) return { loaded: isLoaded(), how: "bootstrapped" };
    if (attempt < BOOTSTRAP_ATTEMPTS) {
      write(`bootstrap failed (attempt ${attempt} of ${BOOTSTRAP_ATTEMPTS}); retrying\n`);
      await sleep(BOOTSTRAP_RETRY_MS);
    }
  }
  // launchd may have taken it despite the last exit code, so ask rather than assume.
  return { loaded: isLoaded(), how: "bootstrap failed" };
}

async function waitForGone(commands, { run, sleep }) {
  for (let waited = 0; waited < BOOTOUT_WAIT_MS; waited += BOOTOUT_POLL_MS) {
    if (run(commands.print) !== 0) return true;
    await sleep(BOOTOUT_POLL_MS);
  }
  return run(commands.print) !== 0;
}

function claudeFallback(entry, dir, env) {
  const block = JSON.stringify({ mcpServers: { browser: entry } }, null, 2);
  return `Add this to ${claudeConfigFile(dir, env)}:\n${block}`;
}

function codexFallback(table, home) {
  return `Add this to ${path.join(home, "config.toml")}:\n${table.trimEnd()}`;
}

function describeCommand(command) {
  const prefix = Object.entries(command.env)
    .map(([key, value]) => (value == null ? `unset ${key}; ` : `${key}=${value} `))
    .join("");
  return `${prefix}${command.bin ?? command.name} ${command.args.join(" ")}`;
}

export function renderPlan(plan, options) {
  const lines = [];
  lines.push(options.uninstall ? "# Browser Bridge uninstall" : "# Browser Bridge install");
  for (const file of plan.files) {
    lines.push(`write ${file.path} (mode ${file.mode.toString(8)})`);
    for (const line of (file.display ?? file.content).trimEnd().split("\n")) lines.push(`    ${line}`);
  }
  for (const target of plan.removals) lines.push(`remove ${target}`);
  for (const edit of plan.edits ?? []) {
    lines.push(`edit ${edit.path}: ${edit.describe}   (a .bak is kept)`);
    for (const line of (edit.preview ?? "").trimEnd().split("\n").filter(Boolean)) lines.push(`    ${line}`);
  }
  for (const command of plan.commands) {
    lines.push(`run  ${describeCommand(command)}${command.optional ? "   (failure ignored)" : ""}`);
    if (!command.bin && !command.optional) {
      lines.push(
        command.orEdit
          ? `     (${command.name} is not on PATH; would edit ${command.orEdit.path} instead)`
          : `     (${command.name} is not on PATH; would print the manual block)`,
      );
    }
  }
  if (plan.launchd) {
    const { uid, label, plist, plistUnchanged, uninstall } = plan.launchd;
    lines.push(`run  ${LAUNCHCTL} print gui/${uid}/${label}   (is it loaded?)`);
    if (uninstall) {
      lines.push(`     if loaded: bootout gui/${uid}/${label}, then poll print until it is gone`);
      lines.push("     if not loaded: nothing to do");
    } else if (plistUnchanged) {
      lines.push(`     the plist on disk already matches, so if it is loaded: kickstart -k gui/${uid}/${label}`);
      lines.push(`     otherwise: bootout, poll print until gone, then bootstrap gui/${uid} ${plist}`);
    } else {
      lines.push(`     if loaded: bootout gui/${uid}/${label}, then poll print until it is gone`);
      lines.push(`     then: bootstrap gui/${uid} ${plist} (up to 5 attempts, 1 s apart)`);
    }
  }
  if (plan.daemon) {
    lines.push(`wait for ${plan.url.replace("/mcp", "/healthz")} to answer (up to 10 s)`);
    lines.push("     and exit non-zero, saying so, if it does not");
  }
  return lines.join("\n");
}

function writeFile(file) {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content, { mode: file.mode });
  fs.chmodSync(file.path, file.mode);
  process.stdout.write(`wrote ${file.path}\n`);
}

function removeFile(target) {
  try {
    fs.unlinkSync(target);
    process.stdout.write(`removed ${target}\n`);
  } catch (error) {
    if (error.code !== "ENOENT") process.stdout.write(`could not remove ${target}: ${error.message}\n`);
  }
}

/**
 * Read, transform, back up, write. `apply` returning null means the file already says
 * what it should, and then nothing is touched at all - no rewrite, no `.bak` churn on a
 * file a live session is also holding open.
 */
export function applyEdit(edit) {
  let text;
  let existed = true;
  try {
    text = fs.readFileSync(edit.path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stdout.write(`could not read ${edit.path}: ${error.message}\n`);
      if (edit.fallback) process.stdout.write(`${edit.fallback}\n\n`);
      return;
    }
    existed = false;
    text = edit.initial ?? "";
  }
  if (!existed && !edit.createIfMissing) {
    process.stdout.write(`${edit.path} is not there, so there is nothing to remove\n`);
    return;
  }

  // Anything of the user's own that this edit is about to take with it gets named, with the
  // backup it will be in. Silently deleting somebody's per-tool settings is not on.
  if (edit.dropped) {
    for (const line of edit.dropped(text)) {
      process.stdout.write(`${edit.label}: dropping ${line} (the previous file is kept at ${edit.path}.bak)\n`);
    }
  }

  let next;
  try {
    next = edit.apply(text);
  } catch (error) {
    process.stdout.write(`${edit.label}: could not edit ${edit.path} (${error.message})\n`);
    if (edit.fallback) process.stdout.write(`${edit.fallback}\n\n`);
    return;
  }
  if (next === null) {
    process.stdout.write(`${edit.label}: ${edit.path} already says this\n`);
    return;
  }

  if (existed) {
    try {
      fs.copyFileSync(edit.path, `${edit.path}.bak`);
    } catch (error) {
      process.stdout.write(`could not back up ${edit.path}: ${error.message}\n`);
      if (edit.fallback) process.stdout.write(`${edit.fallback}\n\n`);
      return;
    }
  }
  // tmp + rename in the same directory, so an interrupted run leaves the old config intact
  // rather than a half-written one. This is a file the agent has to be able to parse at
  // startup, and truncate-then-write has a window in which it cannot.
  fs.mkdirSync(path.dirname(edit.path), { recursive: true });
  const tmp = `${edit.path}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode: edit.mode ?? 0o600 });
    fs.renameSync(tmp, edit.path);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left to clean up
    }
    process.stdout.write(`could not write ${edit.path}: ${error.message}\n`);
    if (edit.fallback) process.stdout.write(`${edit.fallback}\n\n`);
    return;
  }
  process.stdout.write(`edited ${edit.path} (${edit.describe})\n`);
}

/** The installer's own proof that the daemon came up, and the only thing that can give it. */
async function waitForHealth(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() >= deadline) return { ok: false, reason: last };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Returns the exit status, which the launchd sequence reads; 127 when there is no binary. */
function runCommand(command) {
  if (!command.bin) {
    if (command.optional) return 127;
    // An edit of our own is better than a message the user has to act on, but only as a
    // second choice: the CLI is what other sessions expect to be writing that file.
    if (command.orEdit) {
      process.stdout.write(`${command.name} is not installed; editing the config directly\n`);
      applyEdit(command.orEdit);
      return 127;
    }
    process.stdout.write(`${command.name} is not installed; add it by hand:\n${command.fallback}\n\n`);
    return 127;
  }
  // A quiet command is one whose output is noise and whose exit code is the answer -
  // `launchctl print` runs on every poll and prints a page of job state each time.
  if (!command.quiet) process.stdout.write(`$ ${describeCommand(command)}\n`);
  const env = { ...process.env };
  for (const [key, value] of Object.entries(command.env)) {
    if (value == null) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(command.bin, command.args, {
    env,
    stdio: command.quiet ? "ignore" : "inherit",
  });
  const status = result.status ?? 1;
  if (status === 0) return 0;
  // The pre-emptive remove fails whenever nothing was registered, which is the normal case.
  if (command.optional) return status;
  if (command.orEdit) {
    process.stdout.write(`${command.label} refused (exit ${status}); editing the config directly\n`);
    applyEdit(command.orEdit);
    return status;
  }
  process.stdout.write(`${command.label} refused (exit ${status}); add it by hand:\n${command.fallback}\n\n`);
  return status;
}

const HELP = `Browser Bridge installer

  node bin/install.js [--browser edge|chrome] [--chrome-too] [--stdio]
                      [--rotate-token] [--dry-run] [--uninstall]

  --browser <name>  which browser's native messaging directory to write (default: edge)
  --chrome-too      write both Edge's and Chrome's
  --stdio           register one stdio MCP server per session instead of the daemon
  --rotate-token    replace the daemon token and the key-derivation secret. No registration
                    changes: the helper reads the token from daemon.json each time, so a live
                    Claude Code session picks it up on its next call (it re-runs the helper on
                    a 401) and Codex on restart. Every session key changes with the secret, so
                    running sessions get new tab groups
  --dry-run         print every file, edit and command, change nothing
  --uninstall       remove the manifests, the launchd job and the registrations
                    (daemon.json, and so the token, is kept)

Re-run it after every landing: the launchd job runs this checkout's files, so a code
change only reaches sessions once the daemon has been restarted, which this does.
`;

/**
 * `hooks` is how the tests get at the two things that would otherwise reach out of the
 * process: `run` executes a planned command (launchctl, claude, codex) and `health` polls
 * the daemon. Everything else is files, and the tests give it a temporary HOME.
 */
export async function main(argv, env = process.env, hooks = {}) {
  const run = hooks.run ?? runCommand;
  const health = hooks.health ?? waitForHealth;
  const sleep = hooks.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const plan = buildPlan(options, env);
  if (options.dryRun) {
    process.stdout.write(`${renderPlan(plan, options)}\n`);
    if (!options.uninstall) process.stdout.write(`\n${nextSteps(plan, options)}\n`);
    return;
  }

  fs.mkdirSync(runtimeDir(env), { recursive: true, mode: 0o700 });
  for (const file of plan.files) writeFile(file);
  for (const target of plan.removals) removeFile(target);
  for (const edit of plan.edits ?? []) applyEdit(edit);
  for (const command of plan.commands) run(command);

  let reloaded = null;
  if (plan.launchd) reloaded = await reloadDaemon(plan.launchd, { run, sleep });

  if (plan.daemon) {
    const status = reloaded?.loaded === false ? { ok: false, reason: "the launchd job is not loaded" } : await health(plan.url.replace("/mcp", "/healthz"));
    if (status.ok) {
      process.stdout.write(`daemon up on port ${status.port} (pid ${status.pid}), ${status.sessions} session(s)\n`);
    } else {
      // Never "installed" while /healthz is dark: that is exactly how a reload once left
      // every session without a browser and said nothing.
      process.stdout.write(
        `\nTHE DAEMON IS DOWN (${status.reason}; ${reloaded?.how ?? "not reloaded"}).\n` +
          `Look at ${daemonLogPath(env)}, then start it by hand:\n` +
          `  launchctl bootout gui/${plan.launchd.uid}/${plan.launchd.label}\n` +
          `  launchctl bootstrap gui/${plan.launchd.uid} ${plan.launchd.plist}\n` +
          `  curl -s http://127.0.0.1:${plan.daemon.port}/healthz\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (!options.uninstall) process.stdout.write(`\n${nextSteps(plan, options)}\n`);
}

function nextSteps(plan, options = {}) {
  const lines = [
    "Load the extension:",
    "  1. Open edge://extensions and turn on Developer mode.",
    `  2. "Load unpacked" and pick ${path.join(PROJECT_DIR, "extension")}`,
    `  3. The id must come out as ${EXTENSION_ID} (the manifest "key" pins it).`,
    "  4. Open the extension's popup: it should say connected.",
    "",
  ];
  if (options.stdio || !plan.daemon) lines.push(`MCP server: ${plan.nodePath} ${plan.serverPath}`);
  else {
    lines.push(`MCP daemon: ${plan.nodePath} ${plan.daemonPath}`);
    lines.push(`  url     ${plan.url}`);
    lines.push(`  headers ${plan.helperCommand}`);
    lines.push("  A session that was already running has the old registration; restart it.");
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
