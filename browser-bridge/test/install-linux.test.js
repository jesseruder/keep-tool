// The installer's Linux plan, against a temp HOME, on whatever host runs the tests: the
// platform is passed in, so none of this depends on being on Linux. Nothing here runs
// systemctl; a real run gets a fake command runner, as in install.test.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DAEMON_UNIT,
  EDGE_UNIT,
  buildPlan,
  daemonUnit,
  daemonUnitPath,
  edgeUnit,
  edgeUnitPath,
  hostManifest,
  hostManifestPath,
  main,
  parseArgs,
  profileManifestPath,
  renderPlan,
  startUnits,
  stopUnits,
  systemdQuote,
} from "../bin/install.js";
import { DEFAULT_DAEMON_PORT, EXTENSION_ID, HOST_NAME } from "../host/protocol.js";

const RUNTIME = ".local/state/browser-bridge";
const LINUX = { browsers: ["edge"], uninstall: false, platform: "linux" };

function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bb-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A run under systemd or ssh may have no XDG_RUNTIME_DIR; the tests pin one so the
  // commands they compare do not depend on the uid of whoever runs them.
  return { HOME: home, XDG_RUNTIME_DIR: "/run/user/1000" };
}

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
 * Records every command, and for each one which planned files were on disk at that moment:
 * that is how the order of stopping, removing and starting is checked. `failing` lists the
 * systemctl verbs that exit non-zero.
 */
async function runInstaller(argv, env, { failing = [], watch = [] } = {}) {
  const ran = [];
  const output = await capture(() =>
    main(argv, env, {
      platform: "linux",
      run(command) {
        ran.push({ ...command, present: watch.filter((file) => fs.existsSync(file)) });
        if (command.name === "systemctl" && failing.includes(command.args[1])) return 1;
        return 0;
      },
      health: async () => ({ ok: true, port: DEFAULT_DAEMON_PORT, pid: 7, sessions: 0 }),
      sleep: async () => {},
    }),
  );
  const systemctl = ran.filter((command) => command.name === "systemctl");
  return { ran, systemctl, calls: systemctl.map((command) => command.args.slice(1).join(" ")), output };
}

test("--user-data-dir is taken as an absolute directory, and only when it is given", () => {
  assert.equal("userDataDir" in parseArgs([]), false);
  assert.equal(parseArgs(["--user-data-dir", "/home/test/profile"]).userDataDir, "/home/test/profile");
  assert.equal(parseArgs(["--user-data-dir", "profile"]).userDataDir, path.resolve("profile"));
  assert.throws(() => parseArgs(["--user-data-dir"]), /needs a directory/);
  assert.throws(() => parseArgs(["--user-data-dir", "--dry-run"]), /needs a directory/);
});

test("a platform other than macOS or Linux is refused, not guessed at", (t) => {
  const env = fakeHome(t);
  assert.throws(() => buildPlan({ ...LINUX, platform: "win32" }, env), /macOS and Linux, not win32/);
});

test("the Linux plan writes XDG paths, a profile manifest and two user units, and no plist", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ ...LINUX, browsers: ["edge", "chrome"] }, env);
  const runtime = path.join(env.HOME, RUNTIME);

  assert.deepEqual(
    plan.files.map((file) => file.path),
    [
      path.join(runtime, "native-host"),
      path.join(env.HOME, ".config/microsoft-edge/NativeMessagingHosts", `${HOST_NAME}.json`),
      path.join(env.HOME, ".config/google-chrome/NativeMessagingHosts", `${HOST_NAME}.json`),
      path.join(runtime, "edge-profile/NativeMessagingHosts", `${HOST_NAME}.json`),
      path.join(runtime, "daemon.json"),
      path.join(env.HOME, ".config/systemd/user", DAEMON_UNIT),
      path.join(runtime, "daemon.log"),
      path.join(env.HOME, ".config/systemd/user", EDGE_UNIT),
      path.join(runtime, "edge.log"),
    ],
  );
  assert.equal(plan.launchd, null, "no launchd on Linux");
  assert.equal(plan.files.some((file) => file.path.includes("Library")), false);

  // Every manifest is the same file, naming the launcher in the XDG state directory.
  const manifests = plan.files.filter((file) => file.path.endsWith(`${HOST_NAME}.json`));
  for (const file of manifests) {
    assert.deepEqual(JSON.parse(file.content), hostManifest(env, "linux"));
    assert.equal(JSON.parse(file.content).path, path.join(runtime, "native-host"));
    assert.equal(file.mode, 0o644);
  }
  assert.equal(plan.userDataDir, path.join(runtime, "edge-profile"));

  // The launcher pins the runtime directory the installer chose, so a native host started
  // by Edge under systemd finds the same socket as the daemon.
  assert.equal(
    plan.files[0].content,
    `#!/bin/sh\nexport BROWSER_BRIDGE_RUNTIME_DIR='${runtime}'\n` +
      `exec '${process.execPath}' '${path.resolve(import.meta.dirname, "../host/native-host.js")}' "$@"\n`,
  );
  for (const log of plan.files.filter((file) => file.path.endsWith(".log"))) {
    assert.equal(log.mode, 0o600);
    assert.equal(log.append, true);
  }

  assert.deepEqual(plan.systemd.stop, []);
  assert.deepEqual(plan.systemd.start, [
    { unit: DAEMON_UNIT, existed: false },
    { unit: EDGE_UNIT, existed: false },
  ]);
  assert.equal(plan.systemd.daemon, DAEMON_UNIT);
  assert.deepEqual(plan.systemd.env, { XDG_RUNTIME_DIR: "/run/user/1000" });
  // Registration is the same as on a Mac: an http server with the headers helper.
  const add = plan.commands.find((command) => command.name === "claude" && command.args[1] === "add-json");
  assert.deepEqual(JSON.parse(add.args[5]).url, `http://127.0.0.1:${DEFAULT_DAEMON_PORT}/mcp`);
});

test("XDG_CONFIG_HOME and XDG_STATE_HOME move the Linux paths", (t) => {
  const env = { ...fakeHome(t) };
  env.XDG_CONFIG_HOME = path.join(env.HOME, "cfg");
  env.XDG_STATE_HOME = path.join(env.HOME, "state");
  const plan = buildPlan(LINUX, env);
  assert.equal(hostManifestPath("edge", env, "linux"), path.join(env.HOME, "cfg/microsoft-edge/NativeMessagingHosts", `${HOST_NAME}.json`));
  assert.equal(daemonUnitPath(env), path.join(env.HOME, "cfg/systemd/user", DAEMON_UNIT));
  assert.equal(edgeUnitPath(env), path.join(env.HOME, "cfg/systemd/user", EDGE_UNIT));
  assert.equal(plan.files[0].path, path.join(env.HOME, "state/browser-bridge/native-host"));
  assert.match(plan.files.find((file) => file.path === daemonUnitPath(env)).content, new RegExp(
    `Environment=BROWSER_BRIDGE_RUNTIME_DIR="${env.HOME}/state/browser-bridge"`,
  ));
});

test("--user-data-dir puts the profile's manifest where it is told, on either platform", (t) => {
  const env = fakeHome(t);
  const profile = path.join(env.HOME, "profiles", "work");
  const linux = buildPlan({ ...LINUX, userDataDir: profile }, env);
  assert.ok(linux.files.some((file) => file.path === profileManifestPath(profile)));
  assert.equal(linux.files.some((file) => file.path.includes("edge-profile")), false);

  // A Mac has a desktop profile that reads the per-user manifest, so it writes a copy only
  // when asked, straight after the browsers' own, and its plan gains no Linux keys.
  const mac = buildPlan({ browsers: ["edge"], uninstall: false }, env);
  assert.equal(mac.files.some((file) => file.path.includes("NativeMessagingHosts/com.keep") && file.path.includes("profiles")), false);
  assert.equal("systemd" in mac, false);
  const macCopy = buildPlan({ browsers: ["edge"], uninstall: false, userDataDir: profile }, env);
  assert.equal(macCopy.files[2].path, profileManifestPath(profile));
  assert.equal(JSON.parse(macCopy.files[2].content).path, JSON.parse(macCopy.files[1].content).path);
});

test("the daemon's unit runs this checkout's daemon with the runtime dir pinned", () => {
  const env = { HOME: "/home/test" };
  const unit = daemonUnit("/opt/node/bin/node", env, "/srv/bb");
  assert.equal(
    unit,
    [
      "[Unit]",
      "Description=Browser Bridge MCP daemon",
      "",
      "[Service]",
      'ExecStart="/opt/node/bin/node" "/srv/bb/mcp/daemon.js"',
      "WorkingDirectory=/srv/bb",
      'Environment=BROWSER_BRIDGE_RUNTIME_DIR="/home/test/.local/state/browser-bridge"',
      "StandardOutput=append:/home/test/.local/state/browser-bridge/daemon.log",
      "StandardError=append:/home/test/.local/state/browser-bridge/daemon.log",
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
});

test("the Edge unit follows the daemon, restarts on failure and stops the wrapper first", () => {
  const unit = edgeUnit("/opt/node/bin/node", { HOME: "/home/test" }, "/srv/bb");
  assert.match(unit, new RegExp(`^After=${DAEMON_UNIT.replace(".", "\\.")}$`, "m"));
  assert.match(unit, new RegExp(`^Wants=${DAEMON_UNIT.replace(".", "\\.")}$`, "m"));
  assert.match(unit, /^ExecStart="\/opt\/node\/bin\/node" "\/srv\/bb\/bin\/headless-edge\.js"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/test\/\.local\/state\/browser-bridge\/edge\.log$/m);
  assert.match(unit, /^Environment=BROWSER_BRIDGE_RUNTIME_DIR="\/home\/test\/\.local\/state\/browser-bridge"$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("a unit's values survive spaces, quotes, backslashes and percent signs", () => {
  assert.equal(systemdQuote('/a b/"c"\\d%e'), '"/a b/\\"c\\"\\\\d%%e"');
  const unit = daemonUnit("/opt/node/bin/node", { HOME: "/home/test" }, "/srv/100% bb");
  assert.match(unit, /^ExecStart="\/opt\/node\/bin\/node" "\/srv\/100%% bb\/mcp\/daemon\.js"$/m);
  assert.match(unit, /^WorkingDirectory=\/srv\/100%% bb$/m);
  // A line break would end the setting and start one of the attacker's choosing.
  assert.throws(() => daemonUnit("/opt/node\nExecStartPre=/bin/true", { HOME: "/home/test" }, "/srv/bb"), /line break/);
});

test("units that are already there are restarted, not just enabled", (t) => {
  const env = fakeHome(t);
  for (const file of [daemonUnitPath(env), edgeUnitPath(env)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[Unit]\n");
  }
  const plan = buildPlan(LINUX, env);
  assert.deepEqual(plan.systemd.start, [
    { unit: DAEMON_UNIT, existed: true },
    { unit: EDGE_UNIT, existed: true },
  ]);
  const ran = [];
  const result = startUnits(plan.systemd, { run: (command) => ran.push(command.args) && 0, write: () => {} });
  assert.deepEqual(ran, [
    ["--user", "daemon-reload"],
    ["--user", "enable", DAEMON_UNIT],
    ["--user", "restart", DAEMON_UNIT],
    ["--user", "enable", EDGE_UNIT],
    ["--user", "restart", EDGE_UNIT],
    ["--user", "is-active", "--quiet", DAEMON_UNIT],
  ]);
  assert.deepEqual(result, { loaded: true, how: "started" });
});

test("without XDG_RUNTIME_DIR systemctl is pointed at the user manager by uid", (t) => {
  const { HOME } = fakeHome(t);
  const plan = buildPlan(LINUX, { HOME });
  assert.deepEqual(plan.systemd.env, { XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` });
});

test("--stdio on Linux takes the daemon's unit out and keeps the headless Edge", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ ...LINUX, stdio: true }, env);
  assert.equal(plan.daemon, null);
  assert.deepEqual(plan.removals, [daemonUnitPath(env)]);
  assert.ok(plan.files.some((file) => file.path === edgeUnitPath(env)));
  assert.deepEqual(plan.systemd.stop, [DAEMON_UNIT]);
  assert.deepEqual(plan.systemd.start, [{ unit: EDGE_UNIT, existed: false }]);
  assert.equal(plan.systemd.daemon, null);
});

test("a Linux uninstall stops both units and removes both, the profile manifest included", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ ...LINUX, uninstall: true }, env);
  const runtime = path.join(env.HOME, RUNTIME);
  assert.equal(plan.files.length, 0);
  assert.deepEqual(plan.removals, [
    path.join(runtime, "native-host"),
    hostManifestPath("edge", env, "linux"),
    hostManifestPath("chrome", env, "linux"),
    path.join(runtime, "edge-profile/NativeMessagingHosts", `${HOST_NAME}.json`),
    daemonUnitPath(env),
    edgeUnitPath(env),
  ]);
  assert.deepEqual(plan.systemd.stop, [DAEMON_UNIT, EDGE_UNIT]);
  assert.deepEqual(plan.systemd.start, []);
  const ran = [];
  stopUnits(plan.systemd, { run: (command) => ran.push(command.args) && 0 });
  assert.deepEqual(ran, [
    ["--user", "disable", "--now", DAEMON_UNIT],
    ["--user", "disable", "--now", EDGE_UNIT],
  ]);
});

test("a Linux dry run shows the systemd sequence and how the extension gets loaded", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan(LINUX, env);
  const text = renderPlan(plan, LINUX);
  assert.match(text, /\[Service\]\n {4}ExecStart=".*" ".*\/mcp\/daemon\.js"/);
  assert.match(text, /run {2}XDG_RUNTIME_DIR=\/run\/user\/1000 systemctl --user daemon-reload/);
  assert.match(text, new RegExp(`systemctl --user enable --now ${DAEMON_UNIT}   \\(a new unit\\)`));
  assert.match(text, new RegExp(`systemctl --user enable --now ${EDGE_UNIT}   \\(a new unit\\)`));
  assert.match(text, /wait for http:\/\/127\.0\.0\.1:47331\/healthz/);
  assert.equal(text.includes("launchctl"), false);
});

test("a real Linux run stops before removing and starts after writing", async (t) => {
  const env = fakeHome(t);
  const { calls, output } = await runInstaller([], env);
  assert.ok(fs.existsSync(daemonUnitPath(env)));
  assert.ok(fs.existsSync(edgeUnitPath(env)));
  assert.ok(fs.existsSync(path.join(env.HOME, RUNTIME, "edge-profile/NativeMessagingHosts", `${HOST_NAME}.json`)));
  assert.equal(fs.statSync(path.join(env.HOME, RUNTIME, "edge.log")).mode & 0o777, 0o600);
  assert.deepEqual(calls, [
    "daemon-reload",
    `enable --now ${DAEMON_UNIT}`,
    `enable --now ${EDGE_UNIT}`,
    `is-active --quiet ${DAEMON_UNIT}`,
  ]);
  assert.match(output, /daemon up on port 47331 \(pid 7\)/);
  assert.match(output, new RegExp(`should say it loaded ${EXTENSION_ID}`));
  assert.equal(output.includes("edge://extensions"), false, "nobody is going to click Load unpacked here");

  // The uninstall disables each unit while its file is still there to disable.
  const units = [daemonUnitPath(env), edgeUnitPath(env)];
  const gone = await runInstaller(["--uninstall"], env, { watch: units });
  const disables = gone.systemctl.filter((command) => command.args[1] === "disable");
  assert.equal(disables.length, 2);
  for (const command of disables) assert.deepEqual(command.present, units);
  const reload = gone.systemctl.find((command) => command.args[1] === "daemon-reload");
  assert.deepEqual(reload.present, [], "daemon-reload reads the directory once the files are gone");
  assert.equal(fs.existsSync(daemonUnitPath(env)), false);
  assert.equal(fs.existsSync(path.join(env.HOME, RUNTIME, "daemon.json")), true, "the token is kept");
});

test("a daemon unit that does not come up is a non-zero exit with systemd instructions", async (t) => {
  const env = fakeHome(t);
  const before = process.exitCode;
  const { output } = await runInstaller([], env, { failing: ["is-active"] });
  assert.match(output, new RegExp(`THE DAEMON IS DOWN \\(${DAEMON_UNIT.replace(".", "\\.")} is not active; not active\\)`));
  assert.match(output, new RegExp(`systemctl --user status ${DAEMON_UNIT.replace(".", "\\.")}`));
  assert.equal(output.includes("launchctl"), false);
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
});
