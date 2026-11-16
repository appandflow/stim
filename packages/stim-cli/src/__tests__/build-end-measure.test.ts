import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listBuildEndMarkers } from '@stim-cli/core/state';
import { testContext } from './_context.ts';
import { markBuildEnded } from '../build-end-marker.ts';
import { measureBuildEnds } from '../daemon/dependencies.ts';
import { forgetStatusMeasures } from '../status-measures.ts';
import { startBuildEndTimer } from '../stimd/build-end-timer.ts';
import { workspaceDir } from '../workspace/paths.ts';

const refresh = vi.hoisted(() => {
  const state: { calls: string[]; outcome: 'measured' | 'busy'; during: () => void } = {
    calls: [],
    outcome: 'measured',
    during: () => {},
  };
  return state;
});
vi.mock('../disk-usage.ts', async (original) => ({
  ...(await original<typeof import('../disk-usage.ts')>()),
  refreshMeasure: async (path: string) => {
    refresh.calls.push(path);
    refresh.during();
    return { outcome: refresh.outcome, measure: null };
  },
}));

let base: string;
let app: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-build-end-'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  app = join(base, 'app');
  mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
  writeFileSync(join(app, 'android', 'app', 'build', 'x'), 'x');
  refresh.calls = [];
  refresh.outcome = 'measured';
  refresh.during = () => {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const operation = () => testContext({ home: join(base, 'home'), projectRoot: app, cwd: app });

it('measures a marked workspace once and removes only the marks it listed', async () => {
  markBuildEnded(app);
  refresh.during = () => {
    if (listBuildEndMarkers().length === 1) markBuildEnded(app);
  };
  await measureBuildEnds(operation());
  expect(refresh.calls.every((path) => path.endsWith('build'))).toBe(true);
  expect(refresh.calls.length).toBeGreaterThan(0);
  expect(listBuildEndMarkers()).toHaveLength(1);
  refresh.during = () => {};
  await measureBuildEnds(operation());
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('keeps every marker while the walk claim is held', async () => {
  markBuildEnded(app);
  refresh.outcome = 'busy';
  await measureBuildEnds(operation());
  expect(listBuildEndMarkers()).toHaveLength(1);
});

it('drops the marker of a workspace that no longer exists, walking nothing', async () => {
  markBuildEnded(app);
  rmSync(app, { recursive: true, force: true });
  await measureBuildEnds(operation());
  expect(refresh.calls).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('measures the Stim workspace folder of a marked workspace', async () => {
  mkdirSync(workspaceDir(app), { recursive: true });
  markBuildEnded(app);
  await measureBuildEnds(operation());
  expect(refresh.calls).toContain(workspaceDir(app));
});

it('clears the markers of a removed worktree and leaves other workspaces alone', () => {
  const other = join(base, 'other');
  markBuildEnded(app);
  markBuildEnded(app);
  markBuildEnded(other);
  forgetStatusMeasures(app, []);
  expect(listBuildEndMarkers().map((marker) => marker.path)).toEqual([other]);
});

it('starts no second job while one runs, and none for a closing daemon', () => {
  vi.useFakeTimers();
  let busy = false;
  let allowed = true;
  const start = vi.fn<() => void>(() => {
    busy = true;
  });
  const stop = startBuildEndTimer({
    periodMs: 30_000,
    allowed: () => allowed,
    busy: () => busy,
    marked: () => true,
    start,
  });
  vi.advanceTimersByTime(90_000);
  expect(start).toHaveBeenCalledOnce();
  busy = false;
  allowed = false;
  vi.advanceTimersByTime(30_000);
  expect(start).toHaveBeenCalledOnce();
  allowed = true;
  vi.advanceTimersByTime(30_000);
  expect(start).toHaveBeenCalledTimes(2);
  stop();
});
