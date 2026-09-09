#!/usr/bin/env node
'use strict';

// Deliberately inspect the index blobs, not the worktree: the index is what a
// commit publishes. Ignore rules alone do not protect against git add --force.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const git = (args) => execFileSync('git', ['-C', root, ...args]);
const forbidden = /^(?:tasks|archive|digests|reviews|watch|steps|\.keep|launchd)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|standup\.md|[^/]*credentials[^/]*|[^/]*\.(?:pem|key|p12|pfx))$/i;
const allowed = /^(?:bin|web|desktop|scripts|skills|docs|patches|\.github)\/|^(?:README\.md|AGENTS\.md|CLAUDE\.md|LICENSE|\.gitignore|\.gitattributes|\.gitleaks\.toml|package(?:-lock)?\.json)$/;
const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
];

function inspect(name, bytes) {
  const issues = [];
  if (forbidden.test(name) || !allowed.test(name) || /(?:^|\/)(?:node_modules|target|\.git)(?:\/|$)/.test(name)) issues.push('excluded path');
  const text = bytes.toString('utf8');
  if (!bytes.includes(0) && secrets.some((pattern) => pattern.test(text))) issues.push('credential-shaped content');
  return issues;
}

function main() {
  const files = git(['ls-files', '--cached', '-z']).toString().split('\0').filter(Boolean);
  if (!files.length) throw new Error('stage the source files before running the public audit');
  const failures = [];
  for (const name of files) {
    const bytes = git(['show', `:${name}`]);
    for (const issue of inspect(name, bytes)) failures.push(`${name}: ${issue}`);
  }
  // npm packages the worktree, including untracked files under its files list.
  // Preview with scripts disabled to avoid invoking this prepack hook recursively.
  const preview = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  for (const entry of preview[0].files) {
    const name = entry.path;
    const file = path.join(root, name);
    if (fs.lstatSync(file).isSymbolicLink()) { failures.push(`${name}: package symlink`); continue; }
    for (const issue of inspect(name, fs.readFileSync(file))) failures.push(`${name} (package): ${issue}`);
  }
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log(`Public source audit passed: ${files.length} staged files and package contents; no excluded paths or known credential patterns.`);
}

module.exports = { inspect };
if (require.main === module) main();
