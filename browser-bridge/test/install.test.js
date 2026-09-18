// The installer, against a temp HOME. Nothing here touches the real browser profiles,
// the real Claude or Codex configs, or launchd: the dry run writes nothing, the plan is
// checked as data, and a real run gets a fake command runner and a fake health probe.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_TABLE,
  applyEdit,
  buildPlan,
  claudeEdit,
  claudeConfigDirs,
  claudeConfigFile,
  claudeHttpEntry,
  codexHomes,
  codexHttpTable,
  commandLine,
  daemonPlist,
  daemonPlistPath,
  daemonSettings,
  hostManifest,
  hostManifestPath,
  launcherScript,
  main,
  parseArgs,
  shellQuote,
  withClaudeServer,
  withTomlTable,
  withoutClaudeServer,
  withoutTomlTable,
} from "../bin/install.js";
import { DAEMON_LABEL, DEFAULT_DAEMON_PORT, EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME } from "../host/protocol.js";

const RUNTIME = "Library/Application Support/BrowserBridge";

function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bb-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude-secondary"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-secondary", ".claude.json"), "{}");
  // A ~/.claude-* directory with no config is not a config directory.
  fs.mkdirSync(path.join(home, ".claude-notes"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { HOME: home };
}

/** Collects stdout for the whole of an async run, restoring it afterwards. */
async function capture(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

/**
 * A stand-in for the agent CLIs. launchctl is only recorded; `claude` also does what the
 * real one would do to the config file, so the end-to-end assertions stay meaningful
 * without a real Claude Code on PATH.
 */
function fakeCli(env) {
  const ran = [];
  return {
    ran,
    run(command) {
      ran.push(command);
      if (command.name !== "claude") return;
      const dir = command.env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME, ".claude");
      const file = claudeConfigFile(dir, env);
      let text = "{}";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        text = "{}";
      }
      const next =
        command.args[1] === "add-json"
          ? withClaudeServer(text, JSON.parse(command.args[5]))
          : withoutClaudeServer(text);
      if (next !== null) fs.writeFileSync(file, next);
    },
  };
}

/** A real run with nothing that leaves the process: no launchctl, no real CLI, no fetch. */
async function runInstaller(argv, env, health = { ok: true, port: DEFAULT_DAEMON_PORT, pid: 1, sessions: 0 }) {
  const cli = fakeCli(env);
  const output = await capture(() => main(argv, env, { run: cli.run, health: async () => health }));
  return { ran: cli.ran, output };
}

test("arguments select the browsers and the mode", () => {
  assert.deepEqual(parseArgs([]), {
    browsers: ["edge"],
    dryRun: false,
    uninstall: false,
    stdio: false,
    rotateToken: false,
  });
  assert.deepEqual(parseArgs(["--browser", "chrome"]).browsers, ["chrome"]);
  assert.deepEqual(parseArgs(["--chrome-too"]).browsers, ["edge", "chrome"]);
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--uninstall"]).uninstall, true);
  assert.equal(parseArgs(["--stdio"]).stdio, true);
  assert.equal(parseArgs(["--rotate-token"]).rotateToken, true);
  assert.throws(() => parseArgs(["--browser", "safari"]), /--browser must be edge or chrome/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
});

test("the native messaging manifest names the launcher and only our extension", (t) => {
  const env = fakeHome(t);
  const manifest = hostManifest(env);
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [EXTENSION_ORIGIN]);
  assert.equal(manifest.allowed_origins[0], `chrome-extension://${EXTENSION_ID}/`);
  assert.equal(manifest.path, path.join(env.HOME, RUNTIME, "native-host"));

  assert.equal(
    hostManifestPath("edge", env),
    path.join(env.HOME, "Library/Application Support/Microsoft Edge/NativeMessagingHosts", `${HOST_NAME}.json`),
  );
  assert.equal(
    hostManifestPath("chrome", env),
    path.join(
      env.HOME,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    ),
  );
});

test("the launcher execs an absolute node with an absolute script, both quoted", () => {
  const script = launcherScript("/opt/node/bin/node", "/srv/browser-bridge");
  assert.equal(
    script,
    "#!/bin/sh\nexec '/opt/node/bin/node' '/srv/browser-bridge/host/native-host.js' \"$@\"\n",
  );
  assert.equal(script.split("\n").filter(Boolean).length, 2);
});

test("a path with a space or a quote cannot break out of the launcher", () => {
  const script = launcherScript("/opt/my node/bin/node", "/srv/it's here");
  assert.match(script, /exec '\/opt\/my node\/bin\/node'/);
  assert.match(script, /'\/srv\/it'\\''s here\/host\/native-host\.js'/);
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("a config-field command line is quoted only when it has to be", () => {
  // Both clients run the helper through a shell, so quoting works; a plain path stays
  // plain anyway, which is also right for a client that splits on whitespace.
  assert.equal(commandLine("/opt/node/bin/node", "/srv/bb/bin/headers.js"), "/opt/node/bin/node /srv/bb/bin/headers.js");
  assert.equal(commandLine("/opt/my node/node", "/srv/x.js"), "'/opt/my node/node' /srv/x.js");
});

test("every Claude config directory with a config is registered, plus the default", (t) => {
  const env = fakeHome(t);
  const dirs = claudeConfigDirs(env);
  assert.deepEqual(
    dirs.map((entry) => path.basename(entry.dir)),
    [".claude", ".claude-secondary"],
  );
  assert.equal(dirs[0].useEnv, false);
  assert.equal(dirs[1].useEnv, true);
  assert.deepEqual(codexHomes(env), [path.join(env.HOME, ".codex")]);
  // The default directory keeps its config at ~/.claude.json, not inside ~/.claude.
  assert.equal(claudeConfigFile(dirs[0].dir, env), path.join(env.HOME, ".claude.json"));
  assert.equal(claudeConfigFile(dirs[1].dir, env), path.join(env.HOME, ".claude-secondary", ".claude.json"));
});

// --- the daemon's own files ----------------------------------------------

test("daemon.json gets a fresh 32-byte token, and keeps it on every later run", (t) => {
  const env = fakeHome(t);
  const first = daemonSettings({}, env);
  assert.equal(first.port, DEFAULT_DAEMON_PORT);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.equal(first.fresh, true);

  fs.mkdirSync(path.join(env.HOME, RUNTIME), { recursive: true });
  fs.writeFileSync(
    path.join(env.HOME, RUNTIME, "daemon.json"),
    JSON.stringify({ port: 47999, token: first.token }),
  );

  const second = daemonSettings({}, env);
  assert.equal(second.token, first.token, "an existing token is never rotated");
  assert.equal(second.port, 47999, "and neither is the port");
  assert.equal(second.fresh, false);

  const rotated = daemonSettings({ rotateToken: true }, env);
  assert.notEqual(rotated.token, first.token);
  assert.equal(rotated.port, 47999, "--rotate-token changes the token, not the port");
  assert.equal(rotated.fresh, true);
});

test("the launchd job runs this checkout's daemon and logs where the installer says", (t) => {
  const env = fakeHome(t);
  const plist = daemonPlist("/opt/node/bin/node", env, "/srv/bb");
  assert.equal(daemonPlistPath(env), path.join(env.HOME, "Library/LaunchAgents", `${DAEMON_LABEL}.plist`));
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, new RegExp(`<key>Label</key>\\n  <string>${DAEMON_LABEL}</string>`));
  assert.match(
    plist,
    /<key>ProgramArguments<\/key>\n {2}<array>\n {4}<string>\/opt\/node\/bin\/node<\/string>\n {4}<string>\/srv\/bb\/mcp\/daemon\.js<\/string>\n {2}<\/array>/,
  );
  assert.match(plist, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n {2}<integer>5<\/integer>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\n {2}<string>\/srv\/bb<\/string>/);
  const log = path.join(env.HOME, RUNTIME, "daemon.log");
  assert.ok(plist.includes(`<key>StandardOutPath</key>\n  <string>${log}</string>`));
  assert.ok(plist.includes(`<key>StandardErrorPath</key>\n  <string>${log}</string>`));
  // A path with an ampersand would otherwise make the plist unparseable.
  assert.match(daemonPlist("/opt/a&b/node", env, "/srv/x"), /<string>\/opt\/a&amp;b\/node<\/string>/);
});

// --- the plan -------------------------------------------------------------

test("the plan writes the launcher, the manifests, daemon.json and the launchd job", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge", "chrome"], uninstall: false }, env);

  assert.deepEqual(
    plan.files.map((file) => file.path),
    [
      path.join(env.HOME, RUNTIME, "native-host"),
      hostManifestPath("edge", env),
      hostManifestPath("chrome", env),
      path.join(env.HOME, RUNTIME, "daemon.json"),
      daemonPlistPath(env),
    ],
  );
  assert.equal(plan.files[0].mode, 0o700);
  assert.match(plan.files[0].content, /^#!\/bin\/sh\n/);
  assert.deepEqual(JSON.parse(plan.files[1].content), hostManifest(env));

  const config = plan.files[3];
  assert.equal(config.mode, 0o600);
  assert.equal(JSON.parse(config.content).token, plan.daemon.token);
  // The token is the one secret here; it must not reach a terminal or a log.
  assert.equal(config.display.includes(plan.daemon.token), false);
  assert.match(config.display, /"token": "<32 fresh random bytes, hex>"/);

  assert.equal(plan.url, `http://127.0.0.1:${DEFAULT_DAEMON_PORT}/mcp`);
  assert.match(plan.helperCommand, /bin\/headers\.js$/);

  // bootout first, and its failure is the normal case: launchd does not know the label yet.
  const launchctl = plan.commands.filter((command) => command.name === "launchctl");
  assert.equal(launchctl.length, 2);
  assert.deepEqual(launchctl[0].args, ["bootout", `gui/${process.getuid()}/${DAEMON_LABEL}`]);
  assert.equal(launchctl[0].optional, true);
  assert.deepEqual(launchctl[1].args, ["bootstrap", `gui/${process.getuid()}`, daemonPlistPath(env)]);
  assert.equal(launchctl[1].optional, false);
  // Codex's helper field has no CLI flag, so that one is a file edit, not a command.
  assert.deepEqual(plan.commands.filter((command) => command.name === "codex"), []);
});

test("Claude Code is registered through mcp add-json, which is the only CLI path for the helper", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge"], uninstall: false }, env);
  const claude = plan.commands.filter((command) => command.name === "claude");

  assert.equal(claude.length, 4, "a remove and an add-json per config directory");
  assert.deepEqual(claude[0].args, ["mcp", "remove", "--scope", "user", "browser"]);
  assert.equal(claude[0].optional, true);
  // The default dir must shed an inherited CLAUDE_CONFIG_DIR, or a session started under
  // another config dir would register the server there instead.
  assert.deepEqual(claude[0].env, { CLAUDE_CONFIG_DIR: null });
  assert.deepEqual(claude[1].args.slice(0, 5), ["mcp", "add-json", "--scope", "user", "browser"]);
  assert.deepEqual(JSON.parse(claude[1].args[5]), {
    type: "http",
    url: plan.url,
    headersHelper: plan.helperCommand,
  });
  assert.equal(claude[2].env.CLAUDE_CONFIG_DIR, path.join(env.HOME, ".claude-secondary"));
  assert.deepEqual(claude[3].args.slice(0, 2), ["mcp", "add-json"]);

  // A missing or refusing CLI falls back to editing the config, rather than to a message.
  assert.equal(claude[1].orEdit.path, path.join(env.HOME, ".claude.json"));
  assert.deepEqual(JSON.parse(claude[1].orEdit.apply("{}")).mcpServers.browser, JSON.parse(claude[1].args[5]));
  assert.equal(claude[3].orEdit.path, path.join(env.HOME, ".claude-secondary", ".claude.json"));
});

test("Codex is pointed at the daemon's url with the headers helper, by a TOML edit", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge"], uninstall: false }, env);

  assert.deepEqual(
    plan.edits.map((edit) => edit.path),
    [path.join(env.HOME, ".codex", "config.toml")],
  );

  const codex = plan.edits[0];
  assert.match(codex.preview, /^\[mcp_servers\.browser\]\n/);
  assert.match(codex.preview, new RegExp(`url = "${plan.url.replaceAll(".", "\\.")}"`));
  assert.match(codex.preview, /http_headers_helper = "/);
  assert.ok(codex.preview.includes(plan.helperCommand));
  // The host's own request budget is 90 s, so the agent must not give up first.
  assert.match(codex.preview, /tool_timeout_sec = 120\.0\n/, "seconds are a float in TOML, and 120 is a different token");
  assert.match(codex.preview, /startup_timeout_sec = 20\.0\n/);
  // `url` is what makes it a streamable_http server; Codex refuses the helper on stdio.
  assert.equal(codex.preview.includes("command ="), false);

  // Codex runs the helper without the session's environment, so the name and the account
  // come from variables Codex itself reads, and the agent is a constant for a Codex home.
  assert.match(
    codex.preview,
    /env_http_headers = \{ "X-Browser-Bridge-Session" = "BROWSER_BRIDGE_SESSION_NAME", "X-Browser-Bridge-Account" = "KEEP_AGENT_ACCOUNT_ID" \}\n/,
  );
  assert.match(codex.preview, /http_headers = \{ "X-Browser-Bridge-Agent" = "codex" \}\n/);
  // Inline tables, not sub-tables: a `[mcp_servers.browser.http_headers]` header would end
  // this table, and the next run's splice would orphan it instead of replacing it.
  assert.equal(codex.preview.includes("[mcp_servers.browser."), false);
  // The token is the helper's alone, so no header is set by two mechanisms at once and no
  // merge order has to be relied on.
  assert.equal(codex.preview.includes("Authorization"), false);
  assert.equal(codex.preview.includes("bearer_token"), false);
});

test("--stdio keeps the old per-session registration and skips the daemon entirely", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge"], uninstall: false, stdio: true }, env);

  assert.equal(plan.daemon, null);
  assert.deepEqual(plan.edits, []);
  assert.equal(plan.files.some((file) => file.path.endsWith("daemon.json")), false);
  assert.equal(plan.files.some((file) => file.path.endsWith(".plist")), false);
  assert.equal(plan.commands.some((command) => command.name === "launchctl"), false);

  const claude = plan.commands.filter((command) => command.name === "claude");
  assert.equal(claude.length, 4);
  assert.deepEqual(claude[0].args, ["mcp", "remove", "--scope", "user", "browser"]);
  assert.equal(claude[0].optional, true);
  assert.deepEqual(claude[1].args.slice(0, 5), ["mcp", "add-json", "--scope", "user", "browser"]);
  assert.deepEqual(JSON.parse(claude[1].args[5]), {
    type: "stdio",
    command: process.execPath,
    args: [path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "mcp", "server.js")],
  });
  assert.equal(claude[2].env.CLAUDE_CONFIG_DIR, path.join(env.HOME, ".claude-secondary"));

  const codex = plan.commands.filter((command) => command.name === "codex");
  assert.equal(codex.length, 2);
  assert.equal(codex[0].env.CODEX_HOME, path.join(env.HOME, ".codex"));
  assert.deepEqual(codex[1].args.slice(0, 3), ["mcp", "add", "browser"]);
  assert.match(codex[1].fallback, /\[mcp_servers\.browser\]/);
});

test("uninstall removes both browsers' manifests and the launchd job, and keeps the token", (t) => {
  const env = fakeHome(t);
  // Only Edge was asked for, but a manifest left by an earlier --chrome-too would point
  // at a launcher this run is deleting, so both go.
  const plan = buildPlan({ browsers: ["edge"], uninstall: true }, env);
  assert.equal(plan.files.length, 0);
  assert.deepEqual(plan.removals, [
    path.join(env.HOME, RUNTIME, "native-host"),
    hostManifestPath("edge", env),
    hostManifestPath("chrome", env),
    daemonPlistPath(env),
  ]);
  assert.equal(
    plan.removals.some((target) => target.endsWith("daemon.json")),
    false,
    "the token survives an uninstall: a running session's registration still carries it",
  );
  const launchctl = plan.commands.filter((command) => command.name === "launchctl");
  assert.equal(launchctl.length, 1);
  assert.deepEqual(launchctl[0].args, ["bootout", `gui/${process.getuid()}/${DAEMON_LABEL}`]);
  for (const edit of plan.edits) assert.match(edit.describe, /^remove /);
});

test("a missing CLI still tells the user exactly what to add", (t) => {
  const env = fakeHome(t);
  for (const edit of buildPlan({ browsers: ["edge"], uninstall: false }, env).edits) {
    assert.match(edit.fallback, /browser/);
    if (edit.path.endsWith(".toml")) assert.match(edit.fallback, /\[mcp_servers\.browser\]/);
    else assert.match(edit.fallback, /"mcpServers"/);
  }
});

// --- the config edits, as pure functions ---------------------------------

test("the Claude edit replaces only mcpServers.browser", () => {
  const before = JSON.stringify(
    {
      numStartups: 7,
      mcpServers: { other: { command: "/bin/other" }, browser: { type: "stdio", command: "/old/node" } },
      projects: { "/srv": { history: ["a"] } },
    },
    null,
    2,
  );
  const entry = claudeHttpEntry("http://127.0.0.1:47331/mcp", "node headers.js");
  const after = JSON.parse(withClaudeServer(before, entry));
  assert.deepEqual(after.mcpServers.browser, entry);
  assert.deepEqual(after.mcpServers.other, { command: "/bin/other" });
  assert.equal(after.numStartups, 7);
  assert.deepEqual(after.projects, { "/srv": { history: ["a"] } });

  // Nothing to do is null, so no rewrite and no .bak churn.
  assert.equal(withClaudeServer(JSON.stringify(after), entry), null);
  // An empty file is a fresh config, not a crash.
  assert.deepEqual(JSON.parse(withClaudeServer("", entry)).mcpServers.browser, entry);
  assert.throws(() => withClaudeServer("{not json", entry));

  const removed = JSON.parse(withoutClaudeServer(JSON.stringify(after)));
  assert.equal("browser" in removed.mcpServers, false);
  assert.deepEqual(removed.mcpServers.other, { command: "/bin/other" });
  assert.equal(withoutClaudeServer(JSON.stringify(removed)), null, "already gone");
});

test("the edit fallback writes the entry itself and keeps a .bak", async (t) => {
  const env = fakeHome(t);
  const file = path.join(env.HOME, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ numStartups: 5, mcpServers: { other: { command: "/x" } } }, null, 2));
  const entry = claudeHttpEntry("http://127.0.0.1:47331/mcp", "node headers.js");
  const edit = claudeEdit("claude (.claude)", path.join(env.HOME, ".claude"), env, entry);

  await capture(() => applyEdit(edit));
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.mcpServers.browser, entry);
  assert.deepEqual(after.mcpServers.other, { command: "/x" });
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).numStartups, 5);

  // A second pass changes nothing and says so.
  const again = await capture(() => applyEdit(edit));
  assert.match(again, /already says this/);

  // A file that is not valid JSON is reported with the block to paste, not clobbered.
  fs.writeFileSync(file, "{ truncated");
  const broken = await capture(() => applyEdit(edit));
  assert.match(broken, /could not edit/);
  assert.match(broken, /"mcpServers"/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ truncated", "left exactly as it was");

  // Removing when the file is not there at all is not an error.
  const missing = claudeEdit("claude (.claude-gone)", path.join(env.HOME, ".claude-gone"), env, null);
  assert.match(await capture(() => applyEdit(missing)), /nothing to remove/);
});

test("the Codex edit replaces only the [mcp_servers.browser] table", () => {
  const before = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.browser]",
    'command = "/old/node"',
    'args = ["/old/server.js"]',
    "",
    "[mcp_servers.other]",
    'command = "/bin/other"',
    "",
    "[tui]",
    "notifications = true",
    "",
  ].join("\n");
  const table = codexHttpTable("http://127.0.0.1:47331/mcp", "node headers.js");
  const after = withTomlTable(before, CODEX_TABLE, table);

  assert.match(after, /^model = "gpt-5"\n/);
  assert.match(after, /\[mcp_servers\.browser\]\nurl = "http:\/\/127\.0\.0\.1:47331\/mcp"\nhttp_headers_helper = "node headers\.js"\n/);
  // Every line of the replacement stays inside this one table.
  assert.deepEqual(
    after.split("\n").filter((line) => line.startsWith("[")),
    ["[mcp_servers.browser]", "[mcp_servers.other]", "[tui]"],
  );
  assert.equal(after.includes("/old/server.js"), false, "the stdio keys are gone");
  assert.match(after, /\[mcp_servers\.other\]\ncommand = "\/bin\/other"/);
  assert.match(after, /\[tui\]\nnotifications = true/);
  assert.equal(withTomlTable(after, CODEX_TABLE, table), null, "already says this");

  // A file without the table gets it appended, and an empty file gets just the table.
  const appended = withTomlTable('model = "gpt-5"\n', CODEX_TABLE, table);
  assert.equal(appended, `model = "gpt-5"\n\n${table}`);
  assert.equal(withTomlTable("", CODEX_TABLE, table), table);

  const removed = withoutTomlTable(after, CODEX_TABLE);
  assert.equal(removed.includes("mcp_servers.browser"), false);
  assert.match(removed, /\[mcp_servers\.other\]/);
  assert.match(removed, /\[tui\]/);
  assert.equal(withoutTomlTable(removed, CODEX_TABLE), null, "already gone");
});

// --- end to end, on files only -------------------------------------------

test("--dry-run prints every file, edit and command and changes nothing", async (t) => {
  const env = fakeHome(t);
  const { output } = await runInstaller(["--dry-run", "--chrome-too"], env);

  assert.match(output, /# Browser Bridge install/);
  assert.match(output, /write .*BrowserBridge\/native-host \(mode 700\)/);
  assert.match(output, /#!\/bin\/sh/);
  assert.match(output, /Microsoft Edge\/NativeMessagingHosts\/com\.keep\.browser_bridge\.json/);
  assert.match(output, /Google\/Chrome\/NativeMessagingHosts\/com\.keep\.browser_bridge\.json/);
  assert.match(output, new RegExp(`chrome-extension://${EXTENSION_ID}/`));
  assert.match(output, /write .*BrowserBridge\/daemon\.json \(mode 600\)/);
  assert.match(output, /"token": "<32 fresh random bytes, hex>"/);
  assert.equal(/"token": "[0-9a-f]{64}"/.test(output), false, "the real token is never printed");
  assert.match(output, new RegExp(`LaunchAgents/${DAEMON_LABEL.replaceAll(".", "\\.")}\\.plist`));
  assert.match(output, /<key>KeepAlive<\/key>/);
  assert.match(output, /run {2}.*claude mcp remove --scope user browser {3}\(failure ignored\)/);
  assert.match(output, /run {2}.*claude mcp add-json --scope user browser \{"type":"http"/);
  assert.match(output, /CLAUDE_CONFIG_DIR=.*\.claude-secondary/);
  assert.match(output, /edit .*\.codex\/config\.toml: set \[mcp_servers\.browser\]/);
  assert.match(output, /http_headers_helper = /);
  assert.match(output, /env_http_headers = \{ "X-Browser-Bridge-Session" = "BROWSER_BRIDGE_SESSION_NAME"/);
  assert.match(output, /run {2}\/bin\/launchctl bootout gui\/\d+\/com\.keep\.browser_bridge\.daemon {3}\(failure ignored\)/);
  assert.match(output, /run {2}\/bin\/launchctl bootstrap gui\/\d+ /);
  assert.ok(
    output.indexOf("launchctl bootout") < output.indexOf("launchctl bootstrap"),
    "the bootout has to come first",
  );
  assert.match(output, /wait for http:\/\/127\.0\.0\.1:47331\/healthz/);
  assert.match(output, /Load unpacked/);
  assert.match(output, new RegExp(EXTENSION_ID));

  assert.equal(fs.existsSync(path.join(env.HOME, "Library")), false, "a dry run writes nothing");
  assert.equal(fs.readFileSync(path.join(env.HOME, ".claude-secondary", ".claude.json"), "utf8"), "{}");
});

test("a real run writes the files, edits both configs and bootstraps the job", async (t) => {
  const env = fakeHome(t);
  fs.writeFileSync(
    path.join(env.HOME, ".claude.json"),
    JSON.stringify({ numStartups: 2, mcpServers: { other: { command: "/bin/other" } } }, null, 2),
  );
  fs.writeFileSync(path.join(env.HOME, ".codex", "config.toml"), 'model = "gpt-5"\n');

  const { ran, output } = await runInstaller([], env, {
    ok: true,
    port: DEFAULT_DAEMON_PORT,
    pid: 999,
    sessions: 0,
  });

  const launcher = path.join(env.HOME, RUNTIME, "native-host");
  assert.ok(fs.existsSync(launcher));
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(hostManifestPath("edge", env), "utf8")).allowed_origins, [
    EXTENSION_ORIGIN,
  ]);

  const daemonConfig = JSON.parse(fs.readFileSync(path.join(env.HOME, RUNTIME, "daemon.json"), "utf8"));
  assert.match(daemonConfig.token, /^[0-9a-f]{64}$/);
  assert.equal(daemonConfig.port, DEFAULT_DAEMON_PORT);
  assert.equal(fs.statSync(path.join(env.HOME, RUNTIME, "daemon.json")).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(daemonPlistPath(env)));

  const claudeConfig = JSON.parse(fs.readFileSync(path.join(env.HOME, ".claude.json"), "utf8"));
  assert.equal(claudeConfig.mcpServers.browser.type, "http");
  assert.equal(claudeConfig.mcpServers.browser.url, `http://127.0.0.1:${DEFAULT_DAEMON_PORT}/mcp`);
  assert.match(claudeConfig.mcpServers.browser.headersHelper, /bin\/headers\.js$/);
  assert.deepEqual(claudeConfig.mcpServers.other, { command: "/bin/other" }, "nothing else is disturbed");
  assert.equal(claudeConfig.numStartups, 2);
  // That one went through `claude mcp add-json`, so the CLI owns the file and there is no
  // .bak of it: the installer only makes one for a file it edits itself.
  assert.equal(fs.existsSync(path.join(env.HOME, ".claude.json.bak")), false);

  const codexConfig = fs.readFileSync(path.join(env.HOME, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /^model = "gpt-5"\n/);
  assert.match(codexConfig, /\[mcp_servers\.browser\]/);
  assert.match(codexConfig, /http_headers_helper = /);
  assert.equal(fs.readFileSync(path.join(env.HOME, ".codex", "config.toml.bak"), "utf8"), 'model = "gpt-5"\n');

  assert.deepEqual(
    ran.map((command) => `${command.name} ${command.args.slice(0, 2).join(" ")}`),
    [
      "launchctl bootout gui/" + process.getuid() + "/" + DAEMON_LABEL,
      "launchctl bootstrap gui/" + process.getuid(),
      "claude mcp remove",
      "claude mcp add-json",
      "claude mcp remove",
      "claude mcp add-json",
    ],
  );
  assert.match(output, /daemon up on port 47331 \(pid 999\)/);

  // Running it again keeps the token and says the configs already agree.
  const again = await runInstaller([], env);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(env.HOME, RUNTIME, "daemon.json"), "utf8")).token,
    daemonConfig.token,
  );
  // The Claude side goes through the CLI every time, so only the TOML edit can say so.
  assert.match(again.output, /config\.toml already says this/);
  assert.ok(again.ran.some((command) => command.args[1] === "add-json"));
});

test("a daemon that never answers /healthz is reported, not glossed over", async (t) => {
  const env = fakeHome(t);
  const before = process.exitCode;
  const { output } = await runInstaller([], env, { ok: false, reason: "connect ECONNREFUSED" });
  assert.match(output, /did not answer \/healthz within 10 s \(connect ECONNREFUSED\)/);
  assert.match(output, /BrowserBridge\/daemon\.log/);
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
});

test("a dry-run uninstall lists the removals and nothing about loading the extension", async (t) => {
  const env = fakeHome(t);
  const { output } = await runInstaller(["--dry-run", "--uninstall"], env);
  assert.match(output, /# Browser Bridge uninstall/);
  assert.match(output, /remove .*LaunchAgents\/com\.keep\.browser_bridge\.daemon\.plist/);
  assert.match(output, /run {2}.*claude mcp remove --scope user browser/);
  assert.match(output, /edit .*\.codex\/config\.toml: remove \[mcp_servers\.browser\]/);
  assert.match(output, /run {2}\/bin\/launchctl bootout/);
  assert.equal(output.includes("Load unpacked"), false, "there is nothing to load after an uninstall");
  assert.equal(output.includes("bootstrap"), false);
  assert.equal(output.includes("daemon.json"), false, "the token is not touched");
});

test("uninstall takes the registrations and the job out but leaves daemon.json", async (t) => {
  const env = fakeHome(t);
  fs.writeFileSync(path.join(env.HOME, ".claude.json"), "{}");
  fs.writeFileSync(path.join(env.HOME, ".codex", "config.toml"), 'model = "gpt-5"\n');
  await runInstaller([], env);

  const token = JSON.parse(fs.readFileSync(path.join(env.HOME, RUNTIME, "daemon.json"), "utf8")).token;
  const { ran } = await runInstaller(["--uninstall"], env);

  assert.equal(fs.existsSync(path.join(env.HOME, RUNTIME, "native-host")), false);
  assert.equal(fs.existsSync(hostManifestPath("edge", env)), false);
  assert.equal(fs.existsSync(daemonPlistPath(env)), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(env.HOME, RUNTIME, "daemon.json"), "utf8")).token,
    token,
    "the token stays, so a reinstall does not invalidate a running session",
  );
  const claudeConfig = JSON.parse(fs.readFileSync(path.join(env.HOME, ".claude.json"), "utf8"));
  assert.equal("browser" in (claudeConfig.mcpServers ?? {}), false);
  assert.equal(
    fs.readFileSync(path.join(env.HOME, ".codex", "config.toml"), "utf8").includes("mcp_servers.browser"),
    false,
  );
  assert.deepEqual(
    ran.map((command) => `${command.name} ${command.args.slice(0, 2).join(" ")}`),
    ["launchctl bootout gui/" + process.getuid() + "/" + DAEMON_LABEL, "claude mcp remove", "claude mcp remove"],
  );
});

test("--stdio registers the per-session server through the CLIs", async (t) => {
  const env = fakeHome(t);
  const { ran } = await runInstaller(["--stdio"], env);
  assert.equal(fs.existsSync(path.join(env.HOME, RUNTIME, "daemon.json")), false);
  assert.equal(fs.existsSync(daemonPlistPath(env)), false);
  assert.deepEqual(
    ran.map((command) => `${command.name} ${command.args.slice(0, 2).join(" ")}`),
    [
      "claude mcp remove",
      "claude mcp add-json",
      "claude mcp remove",
      "claude mcp add-json",
      "codex mcp remove",
      "codex mcp add",
    ],
  );
});
