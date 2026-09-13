'use strict';

const { createUiRequestServer } = require('./ui-request-server.js');

let frontend = null;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  const done = () => {
    try { if (process.connected) process.disconnect(); } catch {}
    process.exit(0);
  };
  if (!frontend) return done();
  const timer = setTimeout(done, 500);
  timer.unref?.();
  frontend.close(() => { clearTimeout(timer); done(); });
}

process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.on('uncaughtException', (error) => {
  process.stderr.write(`[keep ui] uncaught exception: ${error.stack || error.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  process.stderr.write(`[keep ui] unhandled rejection: ${error && (error.stack || error.message) || error}\n`);
  process.exit(1);
});

process.on('message', (message) => {
  if (!message || stopping) return;
  if (message.type === 'init') {
    if (frontend) return;
    frontend = createUiRequestServer(message.options || {});
    frontend.server.once('error', (error) => { throw error; });
    frontend.listen(message.options.port, message.options.host, () => {
      process.send?.({ type: 'ready', port: frontend.server.address().port });
    });
  } else if (message.type === 'publish') {
    frontend?.publish(message.value);
    process.send?.({ type: 'published', version: message.value?.version });
  } else if (message.type === 'event') {
    frontend?.event(message.value);
    process.send?.({ type: 'event-sent' });
  } else if (message.type === 'shutdown') stop();
});
