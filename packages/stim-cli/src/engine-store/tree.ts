import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { stimBuildId } from '@stim-cli/core/state';
import { clonefileHelper } from '../clonefile.ts';
import { getExecutor } from '../exec.ts';
import { SCHEMA } from './schema.ts';
import { FORMAT, MANIFEST, readManifest, writeRecord } from './store.ts';

const SELF_TEST_TIMEOUT_MS = 60_000;

/** A fresh scratch directory name under the root; GC removes one whose owner is gone or that is an hour old. */
export const scratchName = (): string => `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

function setWritable(path: string, writable: boolean): void {
  const entries = readdirSync(path, { recursive: true, withFileTypes: true }).map((each) =>
    join(each.parentPath, each.name),
  );
  for (const each of writable ? [path, ...entries] : [...entries.toReversed(), path]) {
    const stat = lstatSync(each);
    if (stat.isSymbolicLink()) continue;
    chmodSync(each, writable ? stat.mode | 0o200 : stat.mode & ~0o222);
  }
}

/** Removes a tree that `seal` made read-only. */
export function removeTree(path: string): void {
  setWritable(path, true);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Turns the package tree at `scratch` (its `dist`, `bin` and nested `node_modules`) into the read-only store entry
 * `<root>/<build id>`, with its manifest, and returns the build id.
 */
export function seal(root: string, scratch: string): string {
  const build = stimBuildId(join(scratch, 'dist'));
  if (!build) throw new Error(`${scratch} has no built Stim in dist/.`);
  const { version, engines } = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
  writeRecord(join(scratch, MANIFEST), {
    format: FORMAT,
    build,
    version,
    engines: engines?.node ?? '',
    schema: SCHEMA,
  });
  setWritable(scratch, false);
  if (readManifest(join(root, build))) removeTree(scratch);
  else renameSync(scratch, join(root, build));
  return build;
}

/** Copies the package at `source` to `scratch`: one `clonefile(2)` on APFS, else a copy. */
export async function cloneTree(source: string, scratch: string, ctx: StimContext): Promise<void> {
  const helper = await clonefileHelper(ctx);
  if (helper && (await getExecutor().runFileQuietAsync(helper, [source, scratch], { timeoutMs: 120_000 })) !== null)
    return;
  rmSync(scratch, { recursive: true, force: true });
  cpSync(source, scratch, { recursive: true, verbatimSymlinks: true });
}

/**
 * Installs `stim@<version>` from npm, or a development checkout through `npm pack`, into `scratch`, with npm's cache inside the store. `--install-strategy=shallow`
 * nests the package's dependencies under it, so the package directory is a whole tree.
 */
export async function fetchTree(
  root: string,
  source: { release: string } | { pack: string },
  scratch: string,
  log: (line: string) => void,
): Promise<void> {
  const { installServer } = await import('@stim-cli/server/release-install');
  const installs = join(root, scratchName());
  try {
    const packs = join(installs, 'packs');
    if ('pack' in source) {
      mkdirSync(packs, { recursive: true });
      await getExecutor().runFileAsync('npm', ['pack', '--pack-destination', packs], {
        timeoutMs: 120_000,
        cwd: source.pack,
      });
    }
    const from = 'pack' in source ? { from: packs } : source;
    const options = ['--cache', join(root, '.npm-cache'), '--prefer-offline', '--install-strategy=shallow'];
    const { dir } = await installServer(join(installs, 'versions'), from, process.execPath, log, options);
    renameSync(join(dir, 'node_modules', 'stim'), scratch);
  } finally {
    rmSync(installs, { recursive: true, force: true });
  }
}

/**
 * Loads the entry's `dist/cli.mjs` and runs `engine status --json` in it under a resolve hook that rejects any module
 * outside the entry. Throws when the entry cannot run on its own.
 */
export async function selfTest(root: string, build: string): Promise<void> {
  const output = await getExecutor().runFileAsync(process.execPath, [join(root, build, 'dist', '__self-test.mjs')], {
    timeoutMs: SELF_TEST_TIMEOUT_MS,
    env: { STIM_ENGINE_ROOT: root },
  });
  JSON.parse(output);
}
