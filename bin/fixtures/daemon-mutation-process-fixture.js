'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

process.once('message', ({ operation, input }) => {
  if (operation === 'delay') {
    setTimeout(() => process.send({ result: { ok: true } }, () => process.disconnect()), input.ms);
    return;
  }
  if (operation === 'response-hang') {
    if (input.lockDir) {
      fs.mkdirSync(input.lockDir, { recursive: true });
      fs.writeFileSync(`${input.lockDir}/owner.json`, JSON.stringify({ pid: process.pid, token: 'fixture' }));
    }
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(input.pidFile, String(grandchild.pid));
    process.send({ result: { ok: true } });
    setInterval(() => {}, 1000);
    return;
  }
  process.send({ error: { name: 'FixtureError', message: 'fixture failure', code: 'FIXTURE' } }, () => {
    process.exitCode = 1;
    process.disconnect();
  });
});
