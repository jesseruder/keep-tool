'use strict';
// Optional features. An install that does not want one of these should not have
// its command, its scheduler or its dashboard state at all — not a module that
// runs and finds nothing configured.
//
// `landed` is deliberately not here: review, lint and self-repair all read what
// it records, so switching it off would quietly break them. It stays always-on.
//
// Being off means no command, no scheduler and no dashboard state. It does not
// unload the module: other code may still `require('./slack.js')` as a library
// while the slack feature itself is off.

const FEATURES = {
  standup: {
    description: 'Weekday standup note generated from card activity',
    module: './standup.js',
    command: 'standup',
    // What standup.dashboardState() returns when there is no note to show.
    emptyDashboardState: () => null,
  },
  ideas: {
    description: 'Daily fleet-wide workflow-improvement pass',
    module: './ideas.js',
    command: 'ideas',
  },
  slack: {
    description: 'Read-only Slack polling correlated with cards',
    module: './slack.js',
    command: 'slack',
    // slack.dashboardState() with nothing polled and the default mode.
    emptyDashboardState: () => ({ mode: 'log', lastPollAt: null, recent: [] }),
  },
  discord: {
    description: 'Discord rendered-message polling',
    module: './discord.js',
    command: 'discord',
    // discord.dashboardState() with the reader off and nothing polled.
    emptyDashboardState: () => ({ enabled: false, counts: {}, recent: [] }),
  },
};

function known(name) {
  const feature = FEATURES[name];
  if (!feature) throw new Error(`unknown feature: ${name}`);
  return feature;
}

// The switches this process should obey. An explicit configuration object wins —
// the caller has already read the file. Otherwise KEEP_FEATURES, which
// config.apply() puts in the environment so a child process gets the same answer
// as its parent. Otherwise the configuration file itself. Anything unreadable or
// the wrong shape reads as "no switches", which means every feature is on: an
// install that has never heard of this key must keep working exactly as before.
function switches(config, env = process.env) {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const value = config.features;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  if (env.KEEP_FEATURES !== undefined) {
    try {
      const parsed = JSON.parse(env.KEEP_FEATURES);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  // An explicit data directory is an isolated registry (tests, a second fleet).
  // Do not read another registry's switches into it, exactly as config.apply()
  // and accounts.js refuse to.
  if (env.KEEP_DIR && !env.KEEP_CONFIG) return {};
  try {
    const value = require('./config.js').load(env);
    return value.features && typeof value.features === 'object' && !Array.isArray(value.features) ? value.features : {};
  } catch { return {}; }
}

// Absent means on. Only an explicit `false` switches a feature off, so a
// configuration written before this key existed enables everything.
function enabled(name, config) {
  known(name);
  return switches(config)[name] !== false;
}

function list(config) {
  const current = switches(config);
  return Object.entries(FEATURES).map(([name, feature]) => ({
    name,
    enabled: current[name] !== false,
    description: feature.description,
  }));
}

function load(name) {
  return require(known(name).module);
}

// What `keep <name>` says when its feature is switched off. The path is the file
// the answer came from, so the fix is a file the caller can open.
function offMessage(name, env = process.env) {
  known(name);
  return `feature ${name} is off; enable it with "features": {"${name}": true} in ${require('./config.js').configFile(env)}`;
}

// The module's dashboard state, or the value it returns when it has nothing to
// report. The response shape never changes for a consumer; an off feature simply
// always looks like it has never run.
function dashboardState(name, read, config) {
  const feature = known(name);
  if (enabled(name, config)) return read();
  return feature.emptyDashboardState ? feature.emptyDashboardState() : null;
}

// What `keep init` writes into a new configuration. Existing configurations are
// never touched, so they keep the historical all-on behaviour.
const INIT_FEATURES = { standup: false, ideas: true, slack: false, discord: false };

module.exports = { FEATURES, INIT_FEATURES, dashboardState, enabled, list, load, offMessage, switches };
