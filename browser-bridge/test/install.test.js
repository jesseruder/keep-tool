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
  launchdCommands,
  claudeEdit,
  claudeConfigDirs,
  claudeConfigFile,
  claudeHttpEntry,
  codexHomes,
  codexHttpTable,
  tomlSubTables,
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
 * A stand-in for the commands the installer runs. `claude` does what the real one would do
 * to the config file, so the end-to-end assertions stay meaningful without a real Claude
 * Code on PATH. `launchctl` is scripted: `print` answers from `loaded`, a queue of booleans
 * or one boolean, and `bootstrap`/`kickstart` from a queue of exit codes - which is how the
 * teardown race and its retries are reproduced without launchd.
 */
function fakeCli(env, launchctl = {}) {
  const ran = [];
  // `loaded`: is the job there to begin with. `stuckPolls`: how many `print`s after a
  // bootout still report it, which is launchd's teardown race. `bootstrap`/`kickstart`:
  // queues of exit codes, so a first attempt can fail the way the live run's did.
  let loaded = launchctl.loaded === true;
  let lingering = 0;
  const stuckPolls = launchctl.stuckPolls ?? 0;
  const bootstrap = [...(launchctl.bootstrap ?? [])];
  const kickstart = [...(launchctl.kickstart ?? [])];

  return {
    ran,
    verbs: () => ran.filter((command) => command.name === "launchctl").map((command) => command.args[0]),
    run(command) {
      ran.push(command);
      if (command.name === "launchctl") {
        const verb = command.args[0];
        if (verb === "print") {
          if (lingering > 0) {
            lingering -= 1;
            if (lingering === 0) loaded = false;
            return 0; // still reported, though bootout has already returned
          }
          return loaded ? 0 : 1;
        }
        if (verb === "bootout") {
          if (stuckPolls > 0) lingering = stuckPolls;
          else loaded = false;
          return 0;
        }
        if (verb === "kickstart") return kickstart.length ? kickstart.shift() : 0;
        if (verb === "bootstrap") {
          const status = bootstrap.length ? bootstrap.shift() : 0;
          if (status === 0) loaded = true;
          return status;
        }
        return 0;
      }
      if (command.name !== "claude") return 0;
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
      return 0;
    },
  };
}

/** A real run with nothing that leaves the process: no launchctl, no real CLI, no fetch. */
async function runInstaller(argv, env, options = {}) {
  const health = options.health ?? { ok: true, port: DEFAULT_DAEMON_PORT, pid: 1, sessions: 0 };
  const cli = fakeCli(env, options.launchctl);
  const slept = [];
  const output = await capture(() =>
    main(argv, env, {
      run: cli.run,
      health: async () => health,
      // No real waiting: the poll and the retry backoff are recorded instead.
      sleep: async (ms) => slept.push(ms),
    }),
  );
  return { ran: cli.ran, verbs: cli.verbs(), slept, output };
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

test("daemon.json gets a token and a secret, and keeps both on every later run", (t) => {
  const env = fakeHome(t);
  const first = daemonSettings({}, env);
  assert.equal(first.port, DEFAULT_DAEMON_PORT);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  // The secret is what session keys are derived from. It never leaves this machine: the helper
  // does not read it and it is never sent in a header.
  assert.match(first.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(first.secret, first.token);
  assert.equal(first.fresh, true);

  fs.mkdirSync(path.join(env.HOME, RUNTIME), { recursive: true });
  fs.writeFileSync(
    path.join(env.HOME, RUNTIME, "daemon.json"),
    JSON.stringify({ port: 47999, token: first.token, secret: first.secret }),
  );

  const second = daemonSettings({}, env);
  assert.equal(second.token, first.token, "an existing token is never rotated");
  assert.equal(second.secret, first.secret, "and rotating the secret would move every tab group");
  assert.equal(second.port, 47999, "and neither is the port");
  assert.equal(second.fresh, false);

  // An install from before the secret existed gains one without its token changing.
  fs.writeFileSync(path.join(env.HOME, RUNTIME, "daemon.json"), JSON.stringify({ port: 47999, token: first.token }));
  const upgraded = daemonSettings({}, env);
  assert.equal(upgraded.token, first.token);
  assert.match(upgraded.secret, /^[0-9a-f]{64}$/);
  assert.equal(upgraded.fresh, true, "so it has to be written");

  const rotated = daemonSettings({ rotateToken: true }, env);
  assert.notEqual(rotated.token, first.token);
  assert.notEqual(rotated.secret, first.secret, "--rotate-token rotates both");
  assert.equal(rotated.port, 47999, "but not the port");
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
  assert.equal(JSON.parse(config.content).secret, plan.daemon.secret);
  // Neither may reach a terminal or a log: the token drives the browser and the secret
  // derives every session's key.
  assert.equal(config.display.includes(plan.daemon.token), false);
  assert.equal(config.display.includes(plan.daemon.secret), false);
  assert.match(config.display, /"token": "<32 random bytes, hex>"/);
  assert.match(config.display, /"secret": "<32 random bytes, hex>"/);

  assert.equal(plan.url, `http://127.0.0.1:${DEFAULT_DAEMON_PORT}/mcp`);
  assert.match(plan.helperCommand, /bin\/headers\.js$/);

  // The launchd job is a sequence, not a list of commands: see reloadDaemon.
  assert.deepEqual(plan.commands.filter((command) => command.name === "launchctl"), []);
  assert.equal(plan.launchd.label, DAEMON_LABEL);
  assert.equal(plan.launchd.uid, process.getuid());
  assert.equal(plan.launchd.plist, daemonPlistPath(env));
  assert.equal(plan.launchd.uninstall, false);
  assert.equal(plan.launchd.plistUnchanged, false, "nothing is on disk yet");
  const verbs = launchdCommands(plan.launchd);
  assert.deepEqual(verbs.print.args, ["print", `gui/${process.getuid()}/${DAEMON_LABEL}`]);
  assert.equal(verbs.print.quiet, true, "it runs on every poll and prints a page each time");
  assert.deepEqual(verbs.kickstart.args, ["kickstart", "-k", `gui/${process.getuid()}/${DAEMON_LABEL}`]);
  assert.deepEqual(verbs.bootout.args, ["bootout", `gui/${process.getuid()}/${DAEMON_LABEL}`]);
  assert.deepEqual(verbs.bootstrap.args, ["bootstrap", `gui/${process.getuid()}`, daemonPlistPath(env)]);
  // Codex's helper field has no CLI flag, so that one is a file edit, not a command.
  assert.deepEqual(plan.commands.filter((command) => command.name === "codex"), []);

  // An identical plist already on disk is what lets the reload be a restart in place.
  fs.mkdirSync(path.dirname(daemonPlistPath(env)), { recursive: true });
  fs.writeFileSync(daemonPlistPath(env), daemonPlist(process.execPath, env));
  assert.equal(buildPlan({ browsers: ["edge"], uninstall: false }, env).launchd.plistUnchanged, true);
  fs.writeFileSync(daemonPlistPath(env), "<plist>something else</plist>");
  assert.equal(buildPlan({ browsers: ["edge"], uninstall: false }, env).launchd.plistUnchanged, false);
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
  assert.deepEqual(plan.commands.filter((command) => command.name === "launchctl"), []);
  assert.equal(plan.launchd.uninstall, true);
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

test("a table header with padding or a trailing comment is still the same table", () => {
  const table = codexHttpTable("http://127.0.0.1:47331/mcp", "node headers.js");
  for (const header of [
    "[mcp_servers.browser]",
    "[ mcp_servers.browser ]",
    "[mcp_servers.browser] # the browser bridge",
    "  [mcp_servers.browser]",
  ]) {
    const before = `model = "gpt-5"\n\n${header}\nurl = "http://old"\n\n[tui]\nn = 1\n`;
    const after = withTomlTable(before, CODEX_TABLE, table);
    // Matching by exact line text missed these, so the table was appended a second time and
    // Codex refused the whole file for a duplicate key.
    assert.equal(
      after.split("\n").filter((line) => /^\s*\[\s*mcp_servers\.browser\s*\]/.test(line)).length,
      1,
      header,
    );
    assert.equal(after.includes("http://old"), false, header);
    assert.match(after, /\[tui\]/);
    assert.equal(withoutTomlTable(after, CODEX_TABLE).includes("mcp_servers.browser"), false, header);
  }
});

test("existing sub-tables of the browser server are replaced, not left behind", () => {
  // This is the shape `codex mcp add --url ... ; codex mcp ...` leaves, and the shape the
  // real ~/.codex/config.toml already had for another server: sub-tables, not inline ones.
  const before = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.browser]",
    'url = "http://old"',
    "",
    "[mcp_servers.browser.http_headers]",
    'Authorization = "Bearer stale"',
    "",
    "[mcp_servers.browser.env_http_headers]",
    'X-Thing = "VAR"',
    "",
    "[mcp_servers.other]",
    'command = "/bin/other"',
    "",
  ].join("\n");
  const table = codexHttpTable("http://127.0.0.1:47331/mcp", "node headers.js");
  const after = withTomlTable(before, CODEX_TABLE, table);

  // A leftover [mcp_servers.browser.http_headers] would collide with the inline
  // http_headers the new table declares, and a duplicate key makes the file unreadable.
  assert.equal(after.includes("[mcp_servers.browser."), false, after);
  assert.equal(after.includes("Bearer stale"), false);
  assert.equal(after.includes("http://old"), false);
  assert.match(after, /\[mcp_servers\.other\]\ncommand = "\/bin\/other"/);
  assert.deepEqual(
    after.split("\n").filter((line) => line.startsWith("[")),
    ["[mcp_servers.browser]", "[mcp_servers.other]"],
  );
  assert.equal(withTomlTable(after, CODEX_TABLE, table), null, "and a second run is a no-op");

  const removed = withoutTomlTable(after, CODEX_TABLE);
  assert.equal(removed.includes("mcp_servers.browser"), false);
  assert.match(removed, /\[mcp_servers\.other\]/);

  // Uninstalling the sub-table shape directly takes those with it too.
  const scrubbed = withoutTomlTable(before, CODEX_TABLE);
  assert.equal(scrubbed.includes("mcp_servers.browser"), false, scrubbed);
  assert.equal(scrubbed.includes("Bearer stale"), false);
  assert.match(scrubbed, /\[mcp_servers\.other\]/);
});

test("a config edit is written through a temp file, not over the original", async (t) => {
  const env = fakeHome(t);
  const file = path.join(env.HOME, ".codex", "config.toml");
  fs.writeFileSync(file, 'model = "gpt-5"\n');
  await runInstaller([], env);

  assert.match(fs.readFileSync(file, "utf8"), /\[mcp_servers\.browser\]/);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "the temp file is renamed over, not left");
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), 'model = "gpt-5"\n');
});

test("the user's own [mcp_servers.browser.tools.*] settings are carried across a replacement", () => {
  // Per-tool approval settings are something somebody typed on purpose, and they cannot
  // collide with the inline keys this installer writes. Sweeping them up with the header
  // tables we own was deleting a user's configuration without a word.
  const before = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.browser]",
    'url = "http://old"',
    "",
    "[mcp_servers.browser.http_headers]",
    'Authorization = "Bearer stale"',
    "",
    "[mcp_servers.browser.tools.javascript_tool]",
    'approval_mode = "approve"',
    "",
    "[mcp_servers.browser.tools.file_upload]",
    'approval_mode = "never"',
    "",
    "[tui]",
    "n = 1",
    "",
  ].join("\n");
  const table = codexHttpTable("http://127.0.0.1:47331/mcp", "node headers.js");
  const after = withTomlTable(before, CODEX_TABLE, table);

  // Ours are replaced...
  assert.equal(after.includes("Bearer stale"), false);
  assert.equal(after.includes("http://old"), false);
  assert.equal(after.includes("[mcp_servers.browser.http_headers]"), false);
  // ...and theirs are kept, after the new table, where they still belong to it.
  assert.match(after, /\[mcp_servers\.browser\.tools\.javascript_tool\]\napproval_mode = "approve"/);
  assert.match(after, /\[mcp_servers\.browser\.tools\.file_upload\]\napproval_mode = "never"/);
  assert.ok(
    after.indexOf("[mcp_servers.browser]") < after.indexOf("[mcp_servers.browser.tools.javascript_tool]"),
    "a sub-table has to come after its parent",
  );
  assert.match(after, /\[tui\]\nn = 1/);
  assert.equal(withTomlTable(after, CODEX_TABLE, table), null, "and a second run is a no-op");

  // The installer names what it is about to drop, and never names what it is keeping.
  const dropped = tomlSubTables(before, CODEX_TABLE);
  assert.deepEqual(dropped, [
    "[mcp_servers.browser.http_headers]",
    "[mcp_servers.browser.tools.javascript_tool]",
    "[mcp_servers.browser.tools.file_upload]",
  ]);

  // An uninstall takes everything under the table, tools and all - that is what it is for.
  const removed = withoutTomlTable(after, CODEX_TABLE);
  assert.equal(removed.includes("mcp_servers.browser"), false, removed);
  assert.match(removed, /\[tui\]/);
});

test("a real run says which sub-tables it dropped, and where the old file is", async (t) => {
  const env = fakeHome(t);
  const file = path.join(env.HOME, ".codex", "config.toml");
  fs.writeFileSync(
    file,
    [
      "[mcp_servers.browser]",
      'command = "/old/node"',
      "",
      "[mcp_servers.browser.http_headers]",
      'Authorization = "Bearer stale"',
      "",
      "[mcp_servers.browser.tools.javascript_tool]",
      'approval_mode = "approve"',
      "",
    ].join("\n"),
  );

  const { output } = await runInstaller([], env);

  // Silently deleting somebody's settings is not on, so the ones that go are named.
  assert.match(output, /dropping \[mcp_servers\.browser\.http_headers\]/);
  assert.ok(output.includes(`the previous file is kept at ${file}.bak`), output);
  // And the ones that stay are not reported as dropped, because they are not.
  assert.equal(output.includes("dropping [mcp_servers.browser.tools"), false);

  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /\[mcp_servers\.browser\.tools\.javascript_tool\]\napproval_mode = "approve"/);
  assert.equal(written.includes("Bearer stale"), false);
  assert.match(fs.readFileSync(`${file}.bak`, "utf8"), /Bearer stale/, "and it is all in the backup");
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
  assert.match(output, /"token": "<32 random bytes, hex>"/);
  assert.match(output, /"secret": "<32 random bytes, hex>"/);
  assert.equal(/"(token|secret)": "[0-9a-f]{64}"/.test(output), false, "neither is ever printed");
  assert.match(output, new RegExp(`LaunchAgents/${DAEMON_LABEL.replaceAll(".", "\\.")}\\.plist`));
  assert.match(output, /<key>KeepAlive<\/key>/);
  assert.match(output, /run {2}.*claude mcp remove --scope user browser {3}\(failure ignored\)/);
  assert.match(output, /run {2}.*claude mcp add-json --scope user browser \{"type":"http"/);
  assert.match(output, /CLAUDE_CONFIG_DIR=.*\.claude-secondary/);
  assert.match(output, /edit .*\.codex\/config\.toml: set \[mcp_servers\.browser\]/);
  assert.match(output, /http_headers_helper = /);
  assert.match(output, /env_http_headers = \{ "X-Browser-Bridge-Session" = "BROWSER_BRIDGE_SESSION_NAME"/);
  assert.match(output, /run {2}\/bin\/launchctl print gui\/\d+\/com\.keep\.browser_bridge\.daemon {3}\(is it loaded\?\)/);
  assert.match(output, /if loaded: bootout .*then poll print until it is gone/);
  assert.match(output, /then: bootstrap gui\/\d+ .*\(up to 5 attempts, 1 s apart\)/);
  assert.ok(
    output.indexOf("launchctl print") < output.indexOf("bootstrap gui/"),
    "it asks whether the job is loaded before it touches it",
  );
  assert.match(output, /wait for http:\/\/127\.0\.0\.1:47331\/healthz/);
  assert.match(output, /exit non-zero, saying so, if it does not/);
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

  const { ran, verbs, output } = await runInstaller([], env, {
    health: { ok: true, port: DEFAULT_DAEMON_PORT, pid: 999, sessions: 0 },
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
    ran.filter((command) => command.name === "claude").map((command) => command.args[1]),
    ["remove", "add-json", "remove", "add-json"],
  );
  // Nothing was loaded, so there is nothing to boot out: ask, then bootstrap, then verify.
  assert.deepEqual(verbs, ["print", "bootstrap", "print"]);
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

// --- the launchd teardown race -------------------------------------------
//
// `launchctl bootout` returns before the job is gone, and a bootstrap in that window fails
// with "Bootstrap failed: 5: Input/output error". That happened for real on 2026-09-18: the
// installer took the daemon down, reported success, and left every session without a
// browser. Each of these is one step of the sequence that replaced it.

test("an unchanged plist restarts the loaded job in place instead of tearing it down", async (t) => {
  const env = fakeHome(t);
  // Pre-seed exactly the plist this run would write, and say the job is loaded.
  fs.mkdirSync(path.dirname(daemonPlistPath(env)), { recursive: true });
  fs.writeFileSync(daemonPlistPath(env), daemonPlist(process.execPath, env));

  const { verbs, output } = await runInstaller([], env, { launchctl: { loaded: true } });

  assert.deepEqual(verbs, ["print", "kickstart", "print"], "no bootout, so no race to lose");
  assert.match(output, /plist is unchanged; restarting it in place/);
  assert.match(output, /daemon up on port 47331/);
});

test("a changed plist waits for the teardown to finish before bootstrapping", async (t) => {
  const env = fakeHome(t);
  fs.mkdirSync(path.dirname(daemonPlistPath(env)), { recursive: true });
  fs.writeFileSync(daemonPlistPath(env), "<plist>an older version</plist>");

  // launchd keeps reporting the job for two more polls after bootout returns.
  const { verbs, slept, output } = await runInstaller([], env, {
    launchctl: { loaded: true, stuckPolls: 2 },
  });

  assert.deepEqual(verbs, ["print", "bootout", "print", "print", "print", "bootstrap", "print"]);
  assert.deepEqual(slept, [250, 250], "it polls rather than bootstrapping into the race");
  assert.equal(output.includes("still loaded"), false, "the job did go away, so no complaint");
  assert.match(output, /daemon up on port 47331/);
});

test("a bootstrap that fails once is retried", async (t) => {
  const env = fakeHome(t);
  // Exactly the live failure: the job was booted out, and the first bootstrap got EIO.
  const { verbs, slept, output } = await runInstaller([], env, {
    launchctl: { loaded: true, bootstrap: [5, 0] },
  });

  assert.deepEqual(verbs, ["print", "bootout", "print", "bootstrap", "bootstrap", "print"]);
  assert.deepEqual(slept, [1000], "one second between attempts");
  assert.match(output, /bootstrap failed \(attempt 1 of 5\); retrying/);
  assert.match(output, /daemon up on port 47331/);
});

test("a job that never comes back is a non-zero exit and instructions, not a success", async (t) => {
  const env = fakeHome(t);
  const before = process.exitCode;
  // Every bootstrap attempt fails, which is what left the daemon down in the live run.
  const { verbs, slept, output } = await runInstaller([], env, {
    launchctl: { loaded: true, bootstrap: [5, 5, 5, 5, 5] },
  });

  assert.equal(verbs.filter((verb) => verb === "bootstrap").length, 5, "five attempts, then it stops");
  assert.deepEqual(slept, [1000, 1000, 1000, 1000]);
  assert.match(output, /THE DAEMON IS DOWN \(the launchd job is not loaded; bootstrap failed\)/);
  assert.match(output, /launchctl bootstrap gui\/\d+ .*\.plist/);
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
});

test("a kickstart that fails falls back to the full reload", async (t) => {
  const env = fakeHome(t);
  fs.mkdirSync(path.dirname(daemonPlistPath(env)), { recursive: true });
  fs.writeFileSync(daemonPlistPath(env), daemonPlist(process.execPath, env));

  const { verbs, output } = await runInstaller([], env, {
    launchctl: { loaded: true, kickstart: [1] },
  });

  assert.match(output, /kickstart failed; falling back to a full reload/);
  assert.deepEqual(verbs, ["print", "kickstart", "print", "bootout", "print", "bootstrap", "print"]);
  assert.match(output, /daemon up on port 47331/);
});

test("uninstall tolerates a job that is not loaded", async (t) => {
  const env = fakeHome(t);
  const before = process.exitCode;
  const { verbs, output } = await runInstaller(["--uninstall"], env, { launchctl: { loaded: false } });

  assert.deepEqual(verbs, ["print"], "nothing to boot out, so nothing is run");
  assert.match(output, /is not loaded; nothing to boot out/);
  assert.notEqual(process.exitCode, 1, "a job that is already gone is not a failure");
  process.exitCode = before;
});

test("uninstall waits for a loaded job to actually go away", async (t) => {
  const env = fakeHome(t);
  const { verbs, slept } = await runInstaller(["--uninstall"], env, {
    launchctl: { loaded: true, stuckPolls: 1 },
  });
  assert.deepEqual(verbs, ["print", "bootout", "print", "print", "print"]);
  assert.deepEqual(slept, [250]);
});

test("a daemon that never answers /healthz is reported, not glossed over", async (t) => {
  const env = fakeHome(t);
  const before = process.exitCode;
  const { output } = await runInstaller([], env, { health: { ok: false, reason: "connect ECONNREFUSED" } });
  assert.match(output, /THE DAEMON IS DOWN \(connect ECONNREFUSED; bootstrapped\)/);
  assert.match(output, /BrowserBridge\/daemon\.log/);
  assert.match(output, /launchctl bootstrap gui\/\d+ /, "and how to start it by hand");
  assert.match(output, /curl -s http:\/\/127\.0\.0\.1:47331\/healthz/);
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
  assert.match(output, /run {2}\/bin\/launchctl print gui\/\d+/);
  assert.match(output, /if loaded: bootout /);
  assert.match(output, /if not loaded: nothing to do/);
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
  const { ran, verbs, output } = await runInstaller(["--uninstall"], env);

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
    ran.filter((command) => command.name === "claude").map((command) => command.args[1]),
    ["remove", "remove"],
  );
});

test("--stdio registers the per-session server and takes the daemon job out", async (t) => {
  const env = fakeHome(t);
  // A daemon was installed first, so there is a job and a plist to get rid of.
  await runInstaller([], env);
  assert.ok(fs.existsSync(daemonPlistPath(env)));

  const { ran, verbs, output } = await runInstaller(["--stdio"], env, { launchctl: { loaded: true } });
  assert.equal(fs.existsSync(daemonPlistPath(env)), false, "no job, so no plist");
  // Leaving the job loaded would keep a daemon on the port with nothing registered to it.
  assert.deepEqual(verbs, ["print", "bootout", "print", "print"], "check, boot out, poll, verify");
  assert.equal(output.includes("daemon up on port"), false, "nothing is waiting for /healthz");
  // daemon.json stays: it is the token, and --stdio is meant to be reversible.
  assert.ok(fs.existsSync(path.join(env.HOME, RUNTIME, "daemon.json")));
  assert.deepEqual(
    ran.filter((command) => command.name !== "launchctl").map((command) => `${command.name} ${command.args.slice(0, 2).join(" ")}`),
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
