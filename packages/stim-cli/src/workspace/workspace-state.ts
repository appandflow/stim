import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { readJsonObject } from '../json-file.ts';
import { ensureWorkspaceStorage, workspaceStateFile, workspaceStateLock } from './paths.ts';

export interface WorkspaceState {
  supervisor?: Record<string, unknown>;
  collectors?: Record<string, unknown>;
  lastBuild?: Record<string, unknown>;
  launches?: Record<string, unknown>;
  remoteDevice?: Record<string, unknown>;
  metroTunnel?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readWorkspaceState(root: string): WorkspaceState | null {
  return readJsonObject(workspaceStateFile(root));
}

export function withWorkspaceStateLock<T>(root: string, fn: () => T): T {
  const file = workspaceStateFile(root);
  return withDirLock(workspaceStateLock(root), fn, {
    ensureParent: () => {
      ensureWorkspaceStorage(root);
      mkdirSync(dirname(file), { recursive: true });
    },
  });
}

export function writeWorkspaceState(root: string, patch: WorkspaceState): WorkspaceState {
  return updateWorkspaceState(root, (state) => ({ ...state, ...patch }));
}

export function updateWorkspaceState(root: string, update: (state: WorkspaceState) => WorkspaceState): WorkspaceState {
  return withWorkspaceStateLock(root, () => replaceWorkspaceState(root, update(readWorkspaceState(root) ?? {})));
}

function replaceWorkspaceState(root: string, state: WorkspaceState): WorkspaceState {
  const file = workspaceStateFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
  return state;
}

export function clearWorkspaceStateKeys(root: string, keys: readonly string[]): void {
  if (!existsSync(workspaceStateFile(root))) return;
  withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    const file = workspaceStateFile(root);
    if (!state) {
      try {
        rmSync(file, { force: true });
      } catch {}
      return;
    }
    let changed = false;
    for (const key of keys) {
      if (!(key in state)) continue;
      delete state[key];
      changed = true;
    }
    if (!changed) return;
    if (Object.keys(state).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    replaceWorkspaceState(root, state);
  });
}

export function clearWorkspaceStateKey(root: string, key: string, shouldClear: (value: unknown) => boolean): boolean {
  return withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    if (!state || !(key in state)) return true;
    if (!shouldClear(state[key])) return false;
    delete state[key];
    const file = workspaceStateFile(root);
    if (Object.keys(state).length === 0) {
      try {
        rmSync(file, { force: true });
      } catch {}
      return true;
    }
    replaceWorkspaceState(root, state);
    return true;
  });
}
