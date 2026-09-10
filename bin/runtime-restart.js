'use strict';
// Audited runtime trees. No process-name, directory-prefix or wildcard admission.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function load(root) {
  try {
    const file = path.join(root, '.keep/runtime-restart.json');
    if (fs.statSync(file).size > 1024 * 1024) return [];
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    return policy.version === 1 && Array.isArray(policy.trees) && policy.trees.length <= 64 ? policy.trees : [];
  } catch { return []; }
}
function match({ root, agent, sessionId, parent, child, rows, pinCache = new Map() }) {
  for (const entry of load(root)) {
    try {
      if (entry.agent !== agent || entry.restartSafe !== true || typeof entry.audit !== 'string' || !entry.audit.trim()) continue;
      const pins = entry.files;
      if (!pins || !Object.keys(pins).length || Object.keys(pins).length > 64) continue;
      const checked = new Set();
      const argv = spec => {
        if (!Array.isArray(spec) || !spec.length || spec.length > 64) throw Error('Invalid argv');
        return spec.map(arg => {
          if (arg === '$SESSION_ID') {
            if (!/^[a-z0-9_-]{1,160}$/i.test(sessionId || '')) throw Error('No session identity');
            return sessionId;
          }
          if (typeof arg !== 'string' || !/^[A-Za-z0-9_./:@=,+-]+$/.test(arg)) throw Error('Ambiguous argv');
          return arg;
        });
      };
      const pin = file => {
        if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(pins[file] || '')) throw Error('Unpinned runtime file');
        if (checked.has(file)) return;
        const stat = fs.statSync(file);
        const key = `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (stat.size > 512 * 1024 * 1024) throw Error('Runtime file too large');
        if (!pinCache.has(key)) pinCache.set(key, hash(fs.readFileSync(file)));
        if (pinCache.get(key) !== pins[file]) throw Error('Runtime file changed');
        checked.add(file);
      };
      const checkArgv = (spec, row) => {
        const args = argv(spec);
        if (row.args !== args.join(' ')) throw Error('Runtime command mismatch');
        pin(args[0]);
        // Scripts/absolute path arguments must be pinned too. Never bless an
        // arbitrary kernel, worker or launcher merely because Node runs it.
        for (const arg of args.slice(1)) if (path.isAbsolute(arg)) pin(arg);
      };
      if (argv(entry.parentArgv).join(' ') !== parent.args || argv(entry.tree?.argv).join(' ') !== child.args) continue;
      checkArgv(entry.parentArgv, parent);
      const captured = [], seen = new Set();
      const walk = (node, process, depth) => {
        if (depth > 6 || captured.length >= 64 || seen.has(process.pid) || !process.pidStart) throw Error('Unverified runtime tree');
        seen.add(process.pid); checkArgv(node.argv, process);
        captured.push({ pid: process.pid, ppid: process.ppid, pidStart: process.pidStart, args: process.args });
        const children = rows.filter(p => p.ppid === process.pid);
        const rules = node.children || [];
        if (!Array.isArray(rules) || rules.length > 16) throw Error('Invalid tree');
        for (const sub of children) {
          const rule = rules.find(r => argv(r.argv).join(' ') === sub.args);
          if (!rule) throw Error('Unknown descendant');
          walk(rule, sub, depth + 1);
        }
      };
      if (child.ppid !== parent.pid) continue;
      walk(entry.tree, child, 0);
      for (const file of Object.keys(pins)) pin(file);
      return captured;
    } catch { /* An invalid entry does not suppress other audited trees. */ }
  }
  return null;
}
module.exports = { match };
