import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const watch = fs.watch;
const listeners = new Map();

// https://github.com/nodejs/node/issues/54450: macOS can deliver pre-watch writes as new events.
fs.watch = (path, listener) => {
  const watcher = watch(path, () => {});
  listeners.set(path, listener);
  watcher.once('close', () => listeners.delete(path));
  return watcher;
};
syncBuiltinESMExports();

process.on('message', ({ path, name }) => listeners.get(path)?.('change', name));
