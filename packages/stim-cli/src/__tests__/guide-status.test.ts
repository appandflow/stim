import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, upsertProject } from '../workspace/config.ts';
import {
  checkForUpdate,
  doctorDueReason,
  guideStatus,
  recordDoctorRun,
  renderGuideStatus,
  updateCacheFile,
} from '../guide-status.ts';

const NOW = new Date('2026-09-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-guide-status-'));
  process.env.STIM_HOME = home;
  delete process.env.STIM_NO_UPDATE_CHECK;
});

function appRoot(): string {
  const root = join(home, 'app');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
  return root;
}

afterEach(() => {
  delete process.env.STIM_HOME;
  delete process.env.STIM_NO_UPDATE_CHECK;
  rmSync(home, { recursive: true, force: true });
});

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

test('recordDoctorRun writes one platform, or both when doctor ran without a platform', () => {
  const root = appRoot();
  recordDoctorRun(root, 'ios', '1.4.0', NOW);
  expect(getProject(root)?.doctorRuns).toEqual({ ios: { at: NOW.toISOString(), version: '1.4.0' } });
  const later = new Date(NOW.getTime() + DAY);
  recordDoctorRun(root, undefined, '1.5.0', later);
  expect(getProject(root)?.doctorRuns).toEqual({
    ios: { at: later.toISOString(), version: '1.5.0' },
    android: { at: later.toISOString(), version: '1.5.0' },
  });
});

function fakeFetch(version: string | null) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (version === null) throw new Error('offline');
    return { ok: true, json: async () => ({ version }) } as Response;
  };
  return { fetch, calls };
}

test('checkForUpdate fetches the latest dist-tag, caches it, and reports only a newer version', async () => {
  const { fetch, calls } = fakeFetch('1.5.0');
  expect(await checkForUpdate('1.4.0', { now: NOW, fetch })).toBe('1.5.0');
  expect(calls).toEqual(['https://registry.npmjs.org/stim/latest']);
  expect(JSON.parse(readFileSync(updateCacheFile(), 'utf-8'))).toEqual({
    checkedAt: NOW.toISOString(),
    latest: '1.5.0',
  });
  expect(await checkForUpdate('1.5.0', { now: NOW, fetch })).toBe(null);
  expect(await checkForUpdate('1.6.0-rc.1', { now: NOW, fetch })).toBe(null);
  expect(calls).toHaveLength(1);
});

test('checkForUpdate reuses a cache younger than a day and refreshes an older one', async () => {
  writeFileSync(
    updateCacheFile(),
    JSON.stringify({ checkedAt: new Date(NOW.getTime() - DAY / 2).toISOString(), latest: '1.5.0' }),
  );
  const { fetch, calls } = fakeFetch('1.6.0');
  expect(await checkForUpdate('1.4.0', { now: NOW, fetch })).toBe('1.5.0');
  expect(calls).toHaveLength(0);
  writeFileSync(
    updateCacheFile(),
    JSON.stringify({ checkedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(), latest: '1.5.0' }),
  );
  expect(await checkForUpdate('1.4.0', { now: NOW, fetch })).toBe('1.6.0');
  expect(calls).toHaveLength(1);
});

test('checkForUpdate stamps the check time on failure so an offline machine retries once a day', async () => {
  const { fetch, calls } = fakeFetch(null);
  expect(await checkForUpdate('1.4.0', { now: NOW, fetch })).toBe(null);
  expect(JSON.parse(readFileSync(updateCacheFile(), 'utf-8'))).toEqual({ checkedAt: NOW.toISOString(), latest: null });
  expect(await checkForUpdate('1.4.0', { now: new Date(NOW.getTime() + DAY / 2), fetch })).toBe(null);
  expect(calls).toHaveLength(1);
});

test('checkForUpdate does nothing when STIM_NO_UPDATE_CHECK is set', async () => {
  process.env.STIM_NO_UPDATE_CHECK = '1';
  const { fetch, calls } = fakeFetch('9.0.0');
  expect(await checkForUpdate('1.4.0', { now: NOW, fetch })).toBe(null);
  expect(calls).toHaveLength(0);
});

test('renderGuideStatus names the platforms that need doctor and the available update', () => {
  expect(renderGuideStatus({ running: '1.4.0', doctor: [], latest: null })).toBe(null);
  const both = renderGuideStatus({
    running: '1.4.0',
    doctor: [
      { platform: 'ios', reason: 'never run' },
      { platform: 'android', reason: 'last run with stim 1.3.0' },
    ],
    latest: null,
  });
  expect(both).toContain('STATUS');
  expect(both).toContain('Doctor is due for ios (never run) and android (last run with stim 1.3.0).');
  expect(both).toMatch(/Run before native work:  stim doctor$/m);
  const one = renderGuideStatus({
    running: '1.4.0',
    doctor: [{ platform: 'ios', reason: 'last run 9 days ago' }],
    latest: null,
  });
  expect(one).toContain('Doctor is due for ios (last run 9 days ago).');
  expect(one).toContain('stim doctor --platform ios');
  const update = renderGuideStatus({ running: '1.4.0', doctor: [], latest: '1.5.0' });
  expect(update).toContain('stim 1.5.0 is available (running 1.4.0):  npm install -g stim@latest');
  expect(update).not.toContain('Doctor');
});

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

test('recordDoctorRun leaves the registry alone for a directory that is not an app', () => {
  const notApp = join(home, 'monorepo');
  mkdirSync(notApp);
  writeFileSync(join(notApp, 'package.json'), JSON.stringify({ name: 'monorepo' }));
  recordDoctorRun(notApp, undefined, '1.4.0', NOW);
  expect(getProject(notApp)).toBe(null);
});

test('recordDoctorRun never throws when STIM_HOME cannot be written, so doctor still reports', () => {
  const root = appRoot();
  const locked = join(home, 'locked');
  mkdirSync(locked, { mode: 0o500 });
  process.env.STIM_HOME = join(locked, 'stim-home');
  try {
    expect(() => recordDoctorRun(root, 'ios', '1.4.0', NOW)).not.toThrow();
  } finally {
    chmodSync(locked, 0o700);
  }
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
