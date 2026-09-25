'use strict';

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { searchDatabase, BUSY_TIMEOUT_MS } = require('./session-text-search.js');

// Opened read-only and never created here: turn-index's own open() makes the
// database and migrates it. Until that has happened there is nothing to search.
let handle = null;
function database() {
  if (handle) return handle;
  const file = workerData?.db || require('./turn-index.js').databaseFile();
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  handle = new DatabaseSync(file, { readOnly: true });
  handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return handle;
}

parentPort.on('message', ({ id, query, sessions }) => {
  try {
    const db = database();
    parentPort.postMessage({ id, results: db ? searchDatabase(db, query, { sessions }) : [] });
  } catch (error) {
    // A handle that failed once (a migration mid-swap, a replaced file) is reopened next time.
    try { handle?.close(); } catch {}
    handle = null;
    parentPort.postMessage({ id, error: String(error?.message || error).slice(0, 200) });
  }
});
