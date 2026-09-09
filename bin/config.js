'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configFile(env = process.env) {
  return path.resolve((env.KEEP_CONFIG || path.join(os.homedir(), '.config', 'keep', 'config.json')).replace(/^~(?=\/|$)/, os.homedir()));
}

function load(env = process.env) {
  const file = configFile(env);
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.version !== 1 || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unsupported Keep configuration: ${file}`);
  }
  return value;
}

function apply(env = process.env) {
  // An explicit data directory is an isolated registry (also used by tests).
  // Do not silently import another registry's settings into it.
  const value = env.KEEP_DIR && !env.KEEP_CONFIG ? {} : load(env);
  if (!env.KEEP_DIR && value.dataDir) {
    env.KEEP_DIR = path.resolve(String(value.dataDir).replace(/^~(?=\/|$)/, os.homedir()));
  }
  for (const [key, entry] of Object.entries(value.env || {})) {
    if (!/^KEEP_[A-Z0-9_]+$/.test(key) || ['KEEP_DIR', 'KEEP_CONFIG', 'KEEP_ALLOW_PUSH'].includes(key)) {
      throw new Error(`unsupported Keep configuration key: ${key}`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof entry)) throw new Error(`invalid value for ${key}`);
    if (env[key] === undefined) env[key] = String(entry);
  }
  return value;
}

module.exports = { configFile, load, apply };
