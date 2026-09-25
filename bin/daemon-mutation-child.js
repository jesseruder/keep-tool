'use strict';

async function answer(message) {
  const { operation, input } = message || {};
  try {
    if (input?.root) process.env.KEEP_DIR = input.root;
    const result = await require('./maintenance-tasks.js').run(operation, input || {});
    process.send?.({ result }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({ error: {
      message: String(error?.message || error),
      name: error?.name,
      type: error?.constructor?.name,
      stack: error?.stack,
      code: error?.code,
      stderr: error?.stderr == null ? undefined : String(error.stderr),
    } }, () => { process.exitCode = 1; process.disconnect?.(); });
  }
}

process.once('message', answer);
