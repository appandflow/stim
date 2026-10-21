import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ambientEnv, buildCacheRoot } from '@stim-cli/core';
import { getConfigDir, loadConfig } from './workspace/config.ts';

function existingPath(path: string): { existing: string; resolved: string } {
  const missing: string[] = [];
  let current = resolve(path);
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  const existing = realpathSync(current);
  return { existing, resolved: join(existing, ...missing) };
}

export function filesystemDevice(path: string): number {
  return statSync(existingPath(path).existing).dev;
}

function outsideWorkingTree(path: string): boolean {
  let current = path;
  while (true) {
    if (lstatSync(join(current, '.git'), { throwIfNoEntry: false })) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function temporaryRoot(near: string): string {
  const reference = existingPath(near);
  const insideReference = (path: string) => inside(reference.resolved, path);
  const override = ambientEnv().STIM_TMPDIR ?? loadConfig()?.tempDir;
  if (override !== undefined) {
    if (typeof override !== 'string' || !isAbsolute(override)) {
      throw new Error('STIM_TMPDIR / tempDir must be an absolute directory path.');
    }
    const { existing, resolved } = existingPath(override);
    if (!statSync(existing).isDirectory() || !outsideWorkingTree(existing)) {
      throw new Error(`Temporary directory ${override} must be outside Git working trees.`);
    }
    if (insideReference(resolved)) {
      throw new Error(`Temporary directory ${override} must not be inside ${near}.`);
    }
    accessSync(existing, constants.W_OK);
    return resolved;
  }

  const { existing } = reference;
  const cache = existingPath(buildCacheRoot()).resolved;
  const device = statSync(existing).dev;
  const candidates = [tmpdir()];
  let current = existing === reference.resolved || !statSync(existing).isDirectory() ? dirname(existing) : existing;
  while (statSync(current).dev === device) {
    candidates.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      if (statSync(path).dev !== device || insideReference(path) || inside(cache, path) || !outsideWorkingTree(path))
        continue;
      accessSync(path, constants.W_OK);
      return path;
    } catch {}
  }
  throw new Error(
    `No writable temporary directory on the filesystem containing ${near}. ` +
      `Set STIM_TMPDIR or tempDir in ${join(getConfigDir(), 'config.json')} to a directory outside Git working trees.`,
  );
}

export function makeTemporaryDirectory(near: string, prefix: string): string {
  const root = temporaryRoot(near);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, prefix));
}

export function removeTemporaryEntry(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    chmodSync(path, stat.mode | 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) removeTemporaryEntry(join(path, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

/** Runs `work` with a fresh directory at `path` to use as the child's TMPDIR, and removes it afterwards. */
export async function withScratchTmpdir<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    return await work();
  } finally {
    await removeTemporaryEntryAsync(path).catch(() => {});
  }
}

export async function removeTemporaryEntryAsync(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isDirectory()) {
    await chmod(path, info.mode | 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await removeTemporaryEntryAsync(join(path, entry.name), signal);
    }
  }
  signal?.throwIfAborted();
  await rm(path, { recursive: true, force: true });
  signal?.throwIfAborted();
}
