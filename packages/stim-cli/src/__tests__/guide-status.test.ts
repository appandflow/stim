import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertProject } from '../workspace/config.ts';
import { checkForUpdate, doctorDueReason, guideStatus, recordDoctorCheck, updateCacheFile } from '../guide-status.ts';

const NOW = new Date('2026-09-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-guide-status-'));
  process.env.STIM_HOME = home;
  delete process.env.STIM_NO_UPDATE_CHECK;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  delete process.env.STIM_NO_UPDATE_CHECK;
  rmSync(home, { recursive: true, force: true });
});

function appRoot(): string {
  const root = join(home, 'app');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
  return root;
}

test('doctorDueReason: never run, stale, other version, or fresh', () => {
  expect(doctorDueReason(undefined, '1.4.0', NOW)).toBe('never run');
  const eightDays = { at: new Date(NOW.getTime() - 8 * DAY).toISOString(), version: '1.4.0' };
  expect(doctorDueReason(eightDays, '1.4.0', NOW)).toBe('last run 8 days ago');
  const older = { at: NOW.toISOString(), version: '1.3.0' };
  expect(doctorDueReason(older, '1.4.0', NOW)).toBe('last run with stim 1.3.0');
  const fresh = { at: new Date(NOW.getTime() - 6 * DAY).toISOString(), version: '1.4.0' };
  expect(doctorDueReason(fresh, '1.4.0', NOW)).toBe(null);
  expect(doctorDueReason({ at: 'garbage', version: '1.4.0' }, '1.4.0', NOW)).toBe('never run');
});

test('explicit doctor recording keeps lock contention cancellable without changing state', async () => {
  const root = appRoot();
  const lock = join(home, 'config.lock');
  mkdirSync(lock);
  const controller = new AbortController();
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
    controller.abort();
  }, 10);
  try {
    const recorded = recordDoctorCheck(root, 'ios', '1.4.0', controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await recorded).toMatchObject({
      name: 'AbortError',
    });
    expect(ticked).toBe(true);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    expect(existsSync(lock)).toBe(true);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}, 20_000);

function fakeFetch(version: string | null) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (version === null) throw new Error('offline');
    return { ok: true, json: async () => ({ version }) } as Response;
  };
  return { fetch, calls };
}

test('guideStatus reads the project at cwd and skips doctor lines outside a project', async () => {
  const root = appRoot();
  writeFileSync(join(home, 'not-a-project'), '');
  upsertProject(root, { doctorRuns: { ios: { at: NOW.toISOString(), version: '1.4.0' } } });
  const { fetch } = fakeFetch('1.4.0');
  const inProject = await guideStatus({ projectRoot: root, running: '1.4.0', now: NOW, fetch });
  expect(inProject).toContain('Doctor is due for android (never run).');
  expect(inProject).not.toContain('ios');
  const outside = await guideStatus({ projectRoot: null, running: '1.4.0', now: NOW, fetch });
  expect(outside).toBe(null);
  const notApp = join(home, 'monorepo');
  mkdirSync(notApp);
  writeFileSync(join(notApp, 'package.json'), JSON.stringify({ name: 'monorepo' }));
  expect(await guideStatus({ projectRoot: notApp, running: '1.4.0', now: NOW, fetch })).toBe(null);
});

test('checkForUpdate treats an error status or a body without a version as no answer', async () => {
  for (const response of [
    { ok: false, json: async () => ({ version: '9.0.0' }) },
    { ok: true, json: async () => ({ error: 'not found' }) },
    {
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    },
  ]) {
    rmSync(updateCacheFile(), { force: true });
    const fetch: typeof globalThis.fetch = async () => response as Response;
    expect(await checkForUpdate('1.4.0', { now: NOW, fetch })).toBe(null);
    expect(JSON.parse(readFileSync(updateCacheFile(), 'utf-8'))).toEqual({
      checkedAt: NOW.toISOString(),
      latest: null,
    });
  }
});

test('guideStatus skips the doctor lines when the config is corrupt instead of refusing the guide', async () => {
  const root = appRoot();
  writeFileSync(join(home, 'config.json'), '{not json');
  const { fetch } = fakeFetch('1.5.0');
  const status = await guideStatus({ projectRoot: root, running: '1.4.0', now: NOW, fetch });
  expect(status).toContain('stim 1.5.0 is available');
  expect(status).not.toContain('Doctor');
});
