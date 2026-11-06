import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const manifest = (dir: string): { version: string; files?: string[]; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

/** The directory `name` resolves to from `from`, as Node's resolution walks up the `node_modules` directories. */
function resolvePackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) return null;
  }
}

/**
 * A global npm install of the built package at `source`, without npm: its published files at
 * `<prefix>/lib/node_modules/stim` and its runtime dependencies copied as real directories, hoisted where one version
 * serves every dependent and nested where it does not, placed breadth-first so each package's own dependencies win
 * the top level over deeper ones. The test suite runs npm offline, so a fresh `npm pack` cannot
 * be installed there.
 */
export function machineCopy(source: string, prefix: string): string {
  const target = join(prefix, 'lib', 'node_modules', 'stim');
  mkdirSync(target, { recursive: true });
  const own = manifest(source);
  for (const entry of [...(own.files ?? []), 'package.json'])
    if (existsSync(join(source, entry)))
      cpSync(join(source, entry), join(target, entry), { recursive: true, dereference: true });
  const hoisted = new Map<string, string>();
  const queue: { from: string; into: string }[] = [{ from: source, into: target }];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { from, into } = next;
    for (const name of Object.keys(manifest(from).dependencies ?? {})) {
      const real = resolvePackage(from, name);
      if (!real) continue;
      const known = hoisted.get(name);
      if (known === real) continue;
      const destination = join(known === undefined ? target : into, 'node_modules', name);
      if (known === undefined) hoisted.set(name, real);
      if (existsSync(destination)) continue;
      cpSync(real, destination, {
        recursive: true,
        dereference: true,
        filter: (path) => basename(path) !== 'node_modules' || path === real,
      });
      queue.push({ from: real, into: destination });
    }
  }
  return target;
}
