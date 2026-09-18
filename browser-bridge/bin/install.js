#!/usr/bin/env node
// Registers the native messaging host with Edge (and Chrome on request) and the MCP
// server with every Claude config directory and Codex home on this machine.
//
//   node bin/install.js [--browser edge|chrome] [--chrome-too] [--dry-run] [--uninstall]
//
// Nothing here is clever on purpose: --dry-run prints every file it would write and
// every command it would run, so the whole thing can be read before it touches a
// browser profile.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME, launcherPath, runtimeDir } from "../host/protocol.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_FALLBACK = "/Users/jesseruder/.local/bin/codex";

const BROWSER_DIRS = {
  edge: ["Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"],
  chrome: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
};

export function parseArgs(argv) {
  const options = { browsers: ["edge"], dryRun: false, uninstall: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--uninstall") options.uninstall = true;
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

export function launcherScript(nodePath, projectDir = PROJECT_DIR) {
  // Edge launches native hosts with a minimal environment: no PATH, no nvm shims, so
  // both paths are absolute and there is nothing to resolve at run time.
  return `#!/bin/sh\nexec ${nodePath} ${path.join(projectDir, "host", "native-host.js")} "$@"\n`;
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

export function buildPlan(options, env = process.env, projectDir = PROJECT_DIR) {
  const nodePath = process.execPath;
  const serverPath = path.join(projectDir, "mcp", "server.js");
  const files = [];
  const removals = [];
  const commands = [];

  if (options.uninstall) {
    removals.push(launcherPath(env));
    for (const browser of options.browsers) removals.push(hostManifestPath(browser, env));
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

  const claudeBin = which("claude");
  for (const { dir, useEnv } of claudeConfigDirs(env)) {
    const args = options.uninstall
      ? ["mcp", "remove", "--scope", "user", "browser"]
      : ["mcp", "add", "--scope", "user", "browser", "--", nodePath, serverPath];
    commands.push({
      label: `claude (${path.basename(dir)})`,
      bin: claudeBin,
      name: "claude",
      args,
      // A session started under another config dir inherits CLAUDE_CONFIG_DIR, and
      // the default registration would land there instead of ~/.claude.json.
      env: useEnv ? { CLAUDE_CONFIG_DIR: dir } : { CLAUDE_CONFIG_DIR: null },
      fallback: claudeFallback(nodePath, serverPath, dir),
    });
  }

  const codexBin = which("codex") ?? (fs.existsSync(CODEX_FALLBACK) ? CODEX_FALLBACK : null);
  for (const home of codexHomes(env)) {
    const args = options.uninstall
      ? ["mcp", "remove", "browser"]
      : ["mcp", "add", "browser", "--", nodePath, serverPath];
    commands.push({
      label: `codex (${path.basename(home)})`,
      bin: codexBin,
      name: "codex",
      args,
      env: { CODEX_HOME: home },
      fallback: codexFallback(nodePath, serverPath, home),
    });
  }

  return { files, removals, commands, nodePath, serverPath };
}

function claudeFallback(nodePath, serverPath, dir) {
  const block = JSON.stringify(
    { mcpServers: { browser: { command: nodePath, args: [serverPath] } } },
    null,
    2,
  );
  return `Add this to ${path.join(dir, ".claude.json")} (or ~/.claude.json for the default dir):\n${block}`;
}

function codexFallback(nodePath, serverPath, home) {
  return `Add this to ${path.join(home, "config.toml")}:\n[mcp_servers.browser]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(serverPath)}]`;
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
    for (const line of file.content.trimEnd().split("\n")) lines.push(`    ${line}`);
  }
  for (const target of plan.removals) lines.push(`remove ${target}`);
  for (const command of plan.commands) {
    lines.push(`run  ${describeCommand(command)}`);
    if (!command.bin) lines.push(`     (${command.name} is not on PATH; would print the manual block)`);
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

function runCommand(command) {
  if (!command.bin) {
    process.stdout.write(`${command.name} is not installed; add it by hand:\n${command.fallback}\n\n`);
    return;
  }
  process.stdout.write(`$ ${describeCommand(command)}\n`);
  const env = { ...process.env };
  for (const [key, value] of Object.entries(command.env)) {
    if (value == null) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(command.bin, command.args, { env, stdio: "inherit" });
  if (result.status !== 0) {
    process.stdout.write(
      `${command.label} refused (exit ${result.status}); add it by hand:\n${command.fallback}\n\n`,
    );
  }
}

const HELP = `Browser Bridge installer

  node bin/install.js [--browser edge|chrome] [--chrome-too] [--dry-run] [--uninstall]

  --browser <name>  which browser's native messaging directory to write (default: edge)
  --chrome-too      write both Edge's and Chrome's
  --dry-run         print every file and command, change nothing
  --uninstall       remove the manifests and unregister the MCP servers
`;

export function main(argv, env = process.env) {
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
    process.stdout.write(`\n${nextSteps(plan)}\n`);
    return;
  }

  fs.mkdirSync(runtimeDir(env), { recursive: true, mode: 0o700 });
  for (const file of plan.files) writeFile(file);
  for (const target of plan.removals) removeFile(target);
  for (const command of plan.commands) runCommand(command);
  if (!options.uninstall) process.stdout.write(`\n${nextSteps(plan)}\n`);
}

function nextSteps(plan) {
  return [
    "Load the extension:",
    "  1. Open edge://extensions and turn on Developer mode.",
    `  2. "Load unpacked" and pick ${path.join(PROJECT_DIR, "extension")}`,
    `  3. The id must come out as ${EXTENSION_ID} (the manifest "key" pins it).`,
    "  4. Open the extension's popup: it should say connected.",
    "",
    `MCP server: ${plan.nodePath} ${plan.serverPath}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
