import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installKind } from '../../bin/route.mjs';
import { ownStoreEngine } from '../daemon/engine-switch.ts';
import { engineRoot, FORMAT } from '../engine-store/store.ts';
import { RUN_OP_VERSION } from './run-op-version.ts';

/** F3's per-op entry: `dist/api.mjs` exports it; it resolves the result or rejects a plain failure. */
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

/** The selected engine directory, or null for a development tree, store copy, or missing pointer. */
export function selectedEngineDir(env: NodeJS.ProcessEnv): string | null {
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
  return join(root, dir);
}

/** Loads the selected engine's API for an operation, or falls back to this build when unavailable. */
export function engineRunOp(env: NodeJS.ProcessEnv): Promise<RunOp | null> | null {
  const dir = selectedEngineDir(env);
  return dir ? loadEngineRunOp(dir) : null;
}

/** Loads the selected engine's API, returning null when it is unavailable. */
export function loadEngineRunOp(dir: string): Promise<RunOp | null> {
  let module = modules.get(dir);
  if (!module) {
    module = import(pathToFileURL(join(dir, 'dist', 'api.mjs')).href).then(
      (api: { runOp?: unknown; RUN_OP_VERSION?: unknown }) => {
        const { runOp } = api;
        if (typeof runOp !== 'function') return null;
        const theirs = api.RUN_OP_VERSION ?? 1;
        if (theirs !== RUN_OP_VERSION) {
          const refusal = {
            code: 'STIM_ENGINE_UNAVAILABLE',
            message: `The machine engine speaks run-op ${String(theirs)}, and this stim speaks ${RUN_OP_VERSION}.`,
            remedy: 'Run stim engine update, or update the project to the same stim version as the engine.',
          };
          const refuse: RunOp = () => Promise.reject(refusal);
          return refuse;
        }
        const run: RunOp = (name, args, ctx) => Reflect.apply(runOp, undefined, [name, args, ctx]);
        return run;
      },
      () => null,
    );
    modules.set(dir, module);
  }
  return module;
}
