import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { run } from './shell.mjs';

export function parseDf(text) {
  const line = text.trim().split('\n').at(-1) ?? '';
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) return null;
  return { device: fields[0], freeMb: Math.round(Number(fields[3]) / 1024), mount: fields.slice(5).join(' ') };
}

function nearestExisting(path, exists = existsSync) {
  let current = path;
  while (!exists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export async function describeVolume(path) {
  const real = nearestExisting(path);
  const df = await run('df', ['-P', '-k', real], { timeoutMs: 15_000 });
  const parsed = parseDf(df.stdout);
  return { path, mount: parsed?.mount ?? null, dev: statSync(real).dev, freeMb: parsed?.freeMb ?? null };
}

export function volumeLine(label, volume) {
  const free = volume.freeMb === null ? 'unknown' : `${(volume.freeMb / 1024).toFixed(1)} GB`;
  return `${label}: ${volume.path} on ${volume.mount ?? 'unknown mount'} (device ${volume.dev}), ${free} free`;
}

export function mismatchedVolumes(volumes) {
  const [first, ...rest] = Object.entries(volumes);
  return rest.filter(([, volume]) => volume.dev !== first[1].dev).map(([name]) => name);
}
