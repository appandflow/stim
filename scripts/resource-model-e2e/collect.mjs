import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const TAIL_BYTES = 2 * 1024 * 1024;

function tail(file, bytes = TAIL_BYTES) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export function newestRecordMs(file, events, beforeMs) {
  if (!existsSync(file)) return null;
  let best = null;
  for (const line of tail(file, 4 * TAIL_BYTES)
    .toString('utf8')
    .split('\n')) {
    try {
      const record = JSON.parse(line);
      const at = typeof record.ts === 'number' ? record.ts : Date.parse(record.ts);
      if (events.has(record.event) && Number.isFinite(at) && at <= beforeMs && (best === null || at > best.at)) {
        best = { at, event: record.event };
      }
    } catch {}
  }
  return best;
}

export function collectEvidence(home, out) {
  const target = join(out, 'evidence');
  mkdirSync(target, { recursive: true });
  for (const name of ['daemon', 'maintenance']) {
    const source = join(home, name);
    if (existsSync(source))
      cpSync(source, join(target, name), { recursive: true, filter: (path) => !path.endsWith('.sock') });
  }
  for (const name of ['created-devices.json', 'config.json']) {
    if (existsSync(join(home, name)) && !existsSync(join(target, name))) cpSync(join(home, name), join(target, name));
  }
  const workspaces = join(home, 'workspaces');
  if (!existsSync(workspaces)) return;
  for (const entry of readdirSync(workspaces)) {
    const dir = join(target, 'workspaces', entry);
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(workspaces, entry, 'state.json')))
      cpSync(join(workspaces, entry, 'state.json'), join(dir, 'state.json'));
    const metro = join(workspaces, entry, 'logs', 'metro.ndjson');
    if (existsSync(metro)) writeFileSync(join(dir, 'metro.ndjson.tail'), tail(metro));
  }
}
