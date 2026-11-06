import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';

export const FORMAT: number = 1;
export const MANIFEST = '.stim-manifest.json';
export const BUILD_DIR: RegExp = /^[0-9a-f]{12}$/;
const BAD_KEPT = 20;

/** The engine pointer: the build every routed copy runs. Only `engine-select` writes it. */
export interface Current {
  format: number;
  version: string;
  build: string;
  dir: string;
  node: { path: string; version: string }[];
  engines: string;
  channel: 'latest' | 'next';
  pinned: boolean;
  pinReason: string | null;
  setBy: string;
  setAt: string;
}

export interface Staged {
  format: number;
  dir: string;
  version: string;
  stagedAt: string;
}

export interface Manifest {
  format: number;
  build: string;
  version: string;
  engines: string;
  schema: number;
}

export interface StoreState {
  format: number;
  installed: { dir: string; version: string; installedAt: string }[];
  bad: { build: string; version: string; at: string }[];
}

export type Records = { current: Current | null; staged: Staged | null; previous: string | null; state: StoreState };

/** The record at `file` with its `format`, or null when it is missing or not a JSON object. */
function readJson<T extends { format: unknown }>(file: string): T | null {
  try {
    const value: T = JSON.parse(readFileSync(file, 'utf8'));
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeRecord(file: string, value: unknown): void {
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
  renameSync(partial, file);
}

export function removeRecord(file: string): void {
  rmSync(file, { force: true });
}

export function readManifest(tree: string): Manifest | null {
  const value = readJson<Manifest>(join(tree, MANIFEST));
  return value?.format === FORMAT ? value : null;
}

export function readCurrent(root: string): Current | null {
  const value = readJson<Current>(join(root, 'current.json'));
  if (value !== null && value.format !== FORMAT) throw unknownFormat(join(root, 'current.json'), value.format);
  return value;
}

// compat C2 permanent
export function unknownFormat(file: string, format: unknown): Error {
  return Object.assign(new Error(`${file} has format ${String(format)}, which this stim cannot read.`), {
    code: 'STIM_ROUTER_TOO_OLD',
    remedy: 'Run a newer stim: npx stim@latest, npm i -D stim@latest or npm i -g stim@latest.',
  });
}

function readStaged(root: string): Staged | null {
  const value = readJson<Staged>(join(root, 'staged.json'));
  return value?.format === FORMAT ? value : null;
}

function readState(root: string): StoreState {
  const value = readJson<StoreState>(join(root, 'state.json'));
  if (value?.format === FORMAT) return value;
  const installed = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const manifest = entry.isDirectory() && BUILD_DIR.test(entry.name) ? readManifest(join(root, entry.name)) : null;
    return manifest ? [{ dir: entry.name, version: manifest.version, installedAt: new Date().toISOString() }] : [];
  });
  return { format: FORMAT, installed, bad: [] };
}
// compat end

export function readRecords(root: string): Records {
  if (!existsSync(root))
    return { current: null, staged: null, previous: null, state: { format: FORMAT, installed: [], bad: [] } };
  let previous: string | null = null;
  try {
    previous = readFileSync(join(root, 'previous'), 'utf8').trim() || null;
  } catch {}
  return { current: readCurrent(root), staged: readStaged(root), previous, state: readState(root) };
}

export function writeState(root: string, state: StoreState): void {
  writeRecord(join(root, 'state.json'), { ...state, format: FORMAT, bad: state.bad.slice(-BAD_KEPT) });
}
