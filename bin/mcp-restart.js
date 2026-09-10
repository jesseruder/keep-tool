'use strict';
// Explicit audit policy, not a name-based allowlist. Unknown helpers fail closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[A-Za-z0-9_./:@=,+-]+$/.test(value);
function approved(root, agent, child) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(root, '.keep/mcp-restart.json'), 'utf8'));
    if (policy.version !== 1 || !Array.isArray(policy.servers)) return false;
    return policy.servers.some(entry => {
      try {
      if (entry.agent !== agent || entry.restartSafe !== true || !entry.audit || !path.isAbsolute(entry.configFile)) return false;
      const config = JSON.parse(fs.readFileSync(entry.configFile, 'utf8'));
      const server = config.mcpServers?.[entry.server];
      if (!server || !['stdio', undefined].includes(server.type) || hash(JSON.stringify(server)) !== entry.definitionSha256) return false;
      const argv = [server.command, ...(server.args || [])];
      if (!path.isAbsolute(server.command) || !argv.every(token)) return false;
      // Pins audited implementation files as well as the launcher. Updates need
      // renewed review; no credentials or environment values enter logs/policy.
      const pins = entry.files;
      if (!pins || !pins[server.command] || !Object.keys(pins).length) return false;
      if (!Object.entries(pins).every(([file, digest]) => path.isAbsolute(file) && hash(fs.readFileSync(file)) === digest)) return false;
      const firstLine = fs.readFileSync(server.command, 'utf8').split('\n', 1)[0];
      if (child.args === argv.join(' ')) return true;
      // Kernel shebang expansion: only a single absolute interpreter, never env
      // or a shell wrapper. Ambiguous ps argument boundaries are not admitted.
      const interpreter = /^#!(\/[^\s]+)$/.exec(firstLine)?.[1];
      return Boolean(interpreter && token(interpreter) && child.args === [interpreter, ...argv].join(' '));
      } catch { return false; }
    });
  } catch { return false; }
}
function inspect({ root, agent, sessionId, parent, rows }) {
  const executable = parent.args.split(/\s+/)[0];
  const runtime = agent === 'codex' && executable.startsWith('/') ? path.join(path.dirname(executable), 'codex-code-mode-host') : null;
  const pinCache = new Map(); // One fresh inspection only; never across exit checks.
  return rows.filter(p => p.ppid === parent.pid).flatMap(child => {
    if (agent === 'codex') {
      const tree = require('./runtime-restart').match({ root, agent, sessionId, parent, child, rows, pinCache });
      if (tree) return tree;
    }
    if (!child.pidStart || rows.some(p => p.ppid === child.pid)
      || !(runtime && child.args === runtime) && !approved(root, agent, child)) throw Error('Local background processes are still present');
    return [{ pid: child.pid, ppid: child.ppid, pidStart: child.pidStart, args: child.args }];
  }).sort((a, b) => a.pid - b.pid);
}
function gone(helpers, rows) {
  return helpers.every(h => !rows.some(p => p.pid === h.pid && p.pidStart === h.pidStart));
}
module.exports = { inspect, gone, hash };
