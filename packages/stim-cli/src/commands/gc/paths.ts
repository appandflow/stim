import { realpath, realpathSync } from 'fs';
import { promisify } from 'node:util';
import { resolve } from 'path';

export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Node's promise realpath expands Windows short paths; callback spelling matches realpathSync: https://github.com/nodejs/node/issues/37737.
export const realpathAsync: (path: string) => Promise<string> = promisify(realpath);
