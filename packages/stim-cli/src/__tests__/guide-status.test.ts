import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClaimRoot, legacyDaemonSocket, UPGRADE_GUIDE_URL } from '@stim-cli/core/state';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
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
  const held = tryAcquireClaim({ root: `${lock}.claims`, mode: 'exclusive' }).acquired;
  if (!held) throw new Error('Could not acquire fixture claim.');
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
    expect(readClaimSet(`${lock}.claims`).live).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    controller.abort();
    releaseClaim(held);
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

test('guideStatus sends a home and project an earlier Stim left to the migration guide until they are migrated', async () => {
  const root = appRoot();
  const manifest = (stim: string, extra: Record<string, string> = {}) =>
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '*' }, devDependencies: { stim, ...extra } }),
    );
  manifest('^1.40.0', { '@stim-cli/metro': '1.40.0', '@stim-cli/cache-s3': '^2.0.0' });
  upsertProject(root, { doctorRuns: { ios: { at: NOW.toISOString(), version: '1.40.0' } } });
  const configFile = join(home, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf-8'));
  writeFileSync(configFile, JSON.stringify({ ...config, maintenance: { mode: 'off' } }));
  const claim = tryAcquireClaim({
    root: daemonClaimRoot(),
    mode: 'exclusive',
    label: 'stim-daemon',
    details: { socket: legacyDaemonSocket(), mode: 'on' },
  }).acquired;
  if (!claim) throw new Error('Could not acquire fixture claim.');
  onTestFinished(() => {
    releaseClaim(claim);
  });
  const { fetch } = fakeFetch('2.0.0');
  const env = { ...process.env, STIM_MAINTENANCE: 'off' };

  const upgraded = await guideStatus({ projectRoot: root, running: '2.0.0', env, now: NOW, fetch });
  expect(upgraded).toContain(`Before other work, follow:  ${UPGRADE_GUIDE_URL}`);
  for (const item of [
    'maintenance.mode',
    'STIM_MAINTENANCE',
    `pid ${process.pid}`,
    'stim ^1.40.0',
    '@stim-cli/metro',
    'doctor last ran with stim 1.40.0',
  ])
    expect(upgraded).toContain(item);
  expect(upgraded).not.toContain('cache-s3');

  releaseClaim(claim);
  writeFileSync(configFile, JSON.stringify(config));
  manifest('^2.0.0', { '@stim-cli/core': 'workspace:^' });
  upsertProject(root, { doctorRuns: { ios: { at: NOW.toISOString(), version: '2.0.0' } } });
  const migrated = await guideStatus({ projectRoot: root, running: '2.0.0', env: process.env, now: NOW, fetch });
  expect(migrated ?? '').not.toContain(UPGRADE_GUIDE_URL);
});

test.skipIf(process.platform === 'win32')(
  'guideStatus names a service whose job runs a 1.x stim-server script, not one a 2.0 Stim installed without an engine',
  async () => {
    const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
    const units = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(units, { recursive: true });
    onTestFinished(() => {
      rmSync(launchAgents, { recursive: true, force: true });
      rmSync(join(homedir(), '.config', 'systemd'), { recursive: true, force: true });
    });
    const plist = (label: string, script: string) =>
      `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>${script}</string><string>--port</string><string>7788</string></array><key>StandardOutPath</key><string>/Users/me/Library/Logs/Stim/${label}.log</string></dict></plist>`;
    const unit = (label: string, script: string) =>
      `[Service]\nExecStart=/usr/bin/node ${script} --port 7788\nEnvironment=STIM_SERVICE_LABEL=${label}\n`;
    const old =
      '/Users/me/Library/Application Support/Stim/services/old/versions/1.40.0/node_modules/@stim-cli/server/dist/stim-server.mjs';
    writeFileSync(join(launchAgents, 'old.plist'), plist('old', old));
    writeFileSync(
      join(launchAgents, 'dev.stim-server.plist'),
      plist('dev.stim-server', '/usr/local/lib/node_modules/stim/bin/stim.mjs'),
    );
    writeFileSync(join(units, 'old.service'), unit('old', '/home/me/.npm-global/bin/stim-server'));
    writeFileSync(
      join(units, 'dev.stim-server.service'),
      unit('dev.stim-server', '/home/me/.npm-global/lib/node_modules/stim/bin/stim.mjs'),
    );
    const { fetch } = fakeFetch('2.0.0');
    const status = await guideStatus({
      projectRoot: null,
      cwd: home,
      running: '2.0.0',
      env: process.env,
      now: NOW,
      fetch,
    });
    expect(status).toContain('a service installed by an earlier Stim (old)');
    expect(status).toContain(UPGRADE_GUIDE_URL);

    rmSync(join(launchAgents, 'old.plist'));
    rmSync(join(units, 'old.service'));
    const current = await guideStatus({
      projectRoot: null,
      cwd: home,
      running: '2.0.0',
      env: process.env,
      now: NOW,
      fetch,
    });
    expect(current ?? '').not.toContain(UPGRADE_GUIDE_URL);
  },
);

test.each([
  ['1', true],
  ['^1.40.0', true],
  ['>=1.40.0', false],
  ['^1.40.0 || ^2.0.0', false],
  ['^1.40.0 || >= 2.0.0', false],
  ['>= 1.40.0 < 2.0.0', true],
  ['^1.40.0 || github:org/stim', false],
  ['latest', false],
])('guideStatus reads a stim %s pin as left on 1.x: %s', async (range, pinned) => {
  const root = appRoot();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*', stim: range } }));
  const { fetch } = fakeFetch('2.0.0');
  const status = await guideStatus({ projectRoot: root, running: '2.0.0', env: process.env, now: NOW, fetch });
  expect((status ?? '').includes(`stim ${range}`)).toBe(pinned);
});

test('guideStatus names a retired export that 2.0 ignores without a refusal', async () => {
  const { fetch } = fakeFetch('2.0.0');
  const env = { ...process.env, STIM_REMOTE_BUILD_MODE: 'force' };
  const status = await guideStatus({ projectRoot: null, cwd: home, running: '2.0.0', env, now: NOW, fetch });
  expect(status).toContain('STIM_REMOTE_BUILD_MODE');
  expect(status).toContain(UPGRADE_GUIDE_URL);
});

test('guideStatus leaves an unknown key that no Stim 1.x read to stim settings and doctor', async () => {
  const { fetch } = fakeFetch('2.0.0');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ web: { viewprt: 'phone' } }));
  const status = await guideStatus({
    projectRoot: null,
    cwd: home,
    running: '2.0.0',
    env: process.env,
    now: NOW,
    fetch,
  });
  expect(status ?? '').not.toContain(UPGRADE_GUIDE_URL);
});

test('guideStatus leaves a stim range with a prerelease bound unflagged', async () => {
  const root = appRoot();
  const range = '>=1.40.0 <2.0.0-rc.2';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*', stim: range } }));
  const { fetch } = fakeFetch('2.0.0-rc.1');
  const status = await guideStatus({ projectRoot: root, running: '2.0.0-rc.1', env: process.env, now: NOW, fetch });
  expect(status ?? '').not.toContain(`stim ${range}`);
});
