import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readDiskUsage } from '@stim-cli/core/state';
import { testContext } from './_context.ts';
import { markBuildEnded } from '../build-end-marker.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { measureBuildEnds } from '../daemon/dependencies.ts';
import { upsertProject } from '../workspace/config.ts';
import type { CensusIo } from '../workspace/discovery-census.ts';

const state = vi.hoisted(() => {
  const value: { io: CensusIo | null } = { io: null };
  return value;
});
vi.mock('../workspace/discovery-census.ts', async (original) => {
  const real = await original<typeof import('../workspace/discovery-census.ts')>();
  return {
    ...real,
    buildOutputDirs: (root: string, signal: AbortSignal) =>
      real.buildOutputDirs(root, signal, { platform: 'darwin', ...(state.io ? { io: state.io } : {}) }),
  };
});

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-build-end-key-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it('writes the entry the gc report looks up when the canonical spellings differ in case', async () => {
  const app = join(base, 'app');
  mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
  writeFileSync(join(app, 'android', 'app', 'build', 'x'), 'x'.repeat(4096));
  upsertProject(app, {});
  const respell = (path: string) =>
    path.startsWith(app) ? join(base, 'APP', 'Android', path.slice(app.length + '/android'.length)) : path;
  state.io = {
    readNames: (path) => readdir(path),
    isDirectory: async (path) => (await lstat(path)).isDirectory(),
    lstat: async (path) => {
      const info = await lstat(path);
      return { kind: info.isDirectory() ? 'directory' : 'file', mtimeMs: info.mtimeMs };
    },
    realpath: async (path) => (path === app ? join(base, 'APP') : respell(path)),
    head: async () => null,
  };
  markBuildEnded(app);
  await measureBuildEnds(testContext({ home: join(base, 'home'), projectRoot: app, cwd: app }));
  const reported = readDiskUsage(canonicalPath(join(app, 'android', 'app', 'build')));
  expect(reported?.bytes).toBeGreaterThan(0);
});
