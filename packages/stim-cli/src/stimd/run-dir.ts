import { lstatSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HOME_ENTRIES = new Set(['config.json', 'daemon', 'workspaces']);

function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

export function runDirRemoved(run: string): boolean {
  if (!missing(run)) return false;
  try {
    return readdirSync(dirname(run)).some((entry) => HOME_ENTRIES.has(entry));
  } catch {
    return false;
  }
}
