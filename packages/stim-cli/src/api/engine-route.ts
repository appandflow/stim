import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installKind } from '../../bin/route.mjs';
import { ownStoreEngine } from '../daemon/engine-switch.ts';
import { engineRoot, FORMAT } from '../engine-store/store.ts';

/** F3's per-op entry: `dist/api.mjs` and `dist/ci.mjs` export it; it resolves the result or rejects a plain failure. */
export type RunOp = (name: string, args: unknown[], ctx: unknown) => Promise<unknown>;

let pointer: { root: string; key: string; dir: string | null } | null = null;
const modules = new Map<string, Promise<RunOp | null>>();

function pointedDir(root: string): string | null {
  const stat = statSync(join(root, 'current.json'), { throwIfNoEntry: false });
  if (!stat) return null;
  const key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  if (pointer?.root === root && pointer.key === key) return pointer.dir;
  let dir: string | null = null;
  try {
    const current = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
    dir = current?.format === FORMAT && typeof current.dir === 'string' ? current.dir : null;
  } catch {}
  pointer = { root, key, dir };
  return dir;
}

/**
 * The engine's `runOp` when the machine engine runs another build than this copy, as the router decides for a CLI
 * command; null when no engine is installed, this copy runs from the store (a stimd's own clients and the engine's
 * own build follow switches by relaunching), this copy is a development tree, which runs in place, or the engine's
 * `dist/api.mjs` cannot load. Each call stats `current.json` once and reads it only
 * when it changed, so an op started after a switch runs the new build.
 */
export function engineRunOp(env: NodeJS.ProcessEnv): Promise<RunOp | null> | null {
  if (ownStoreEngine()) return null;
  const root = engineRoot(env);
  const dir = pointedDir(root);
  if (!dir) return null;
  const self = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    if (installKind(realpathSync(self), realpathSync(root)) === 'development') return null;
  } catch {
    return null;
  }
  let module = modules.get(dir);
  if (!module) {
    module = import(pathToFileURL(join(root, dir, 'dist', 'api.mjs')).href).then(
      (api: { runOp?: unknown }) => {
        const { runOp } = api;
        if (typeof runOp !== 'function') return null;
        const run: RunOp = (name, args, ctx) => Reflect.apply(runOp, undefined, [name, args, ctx]);
        return run;
      },
      () => null,
    );
    modules.set(dir, module);
  }
  return module;
}
