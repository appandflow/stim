import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { relative, sep } from 'node:path';
import { mock } from 'node:test';

mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });

const watch = fs.watch;
const listeners = new Map();

// https://github.com/nodejs/node/issues/54450: macOS can deliver pre-watch writes as new events.
fs.watch = (path, options, listener) => {
  if (typeof options === 'function') listener = options;
  const watcher = watch(path, () => {});
  listeners.set(path, { listener, recursive: options?.recursive === true });
  watcher.once('close', () => listeners.delete(path));
  return watcher;
};
syncBuiltinESMExports();

process.on('message', ({ path, name, advanceMs }) => {
  if (typeof advanceMs === 'number') {
    mock.timers.tick(advanceMs);
    process.send({ advanceMs });
    return;
  }
  const exact = listeners.get(path);
  if (exact) return exact.listener('change', name);
  for (const [root, { listener, recursive }] of listeners) {
    if (recursive && path.startsWith(root + sep))
      listener('change', name === null ? null : relative(root, path + sep + name));
  }
});
