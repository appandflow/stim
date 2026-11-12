import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClaimRoot, daemonDir, daemonSnapshotFile, type DaemonStatus } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { daemonFindings, daemonLine, daemonStatus, lastActionLine } from '../daemon/status.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const running = { pid: 4242, since: '2026-11-02T11:00:00.000Z' };
const status = (over: Partial<DaemonStatus>): DaemonStatus => ({
  mode: 'on',
  running: null,
  lastTickAt: null,
  intervalMs: 60_000,
  ...over,
});
const titles = (value: DaemonStatus, serving: string[] = []) =>
  daemonFindings(value, { now: NOW, serving: () => serving }).map((finding) => finding.title);

test.each<[string, DaemonStatus, string[], string[]]>([
  [
    'a crash hold',
    status({ crashHold: { build: 'b', count: 3, until: '2026-11-02T12:05:00.000Z', remedy: 'fix it' } }),
    [],
    ['stimd is held after a crash loop'],
  ],
  [
    'an abnormal exit with no hold',
    status({ abnormalExits: [{ at: '2026-11-02T10:00:00.000Z', build: 'b', pid: 1, reason: 'killed' }] }),
    [],
    ['stimd exited abnormally once in the last day'],
  ],
  ['a daemon that ticked a minute ago', status({ running, lastTickAt: '2026-11-02T11:59:00.000Z' }), ['/app'], []],
  [
    'a daemon whose last tick is older than three intervals',
    status({ running, lastTickAt: '2026-11-02T11:56:00.000Z' }),
    [],
    ['The stim-daemon has stopped ticking'],
  ],
  [
    'a daemon started 30 seconds ago that has not ticked yet',
    status({ running: { pid: 4242, since: '2026-11-02T11:59:30.000Z' } }),
    ['/app'],
    [],
  ],
  [
    'a daemon started 30 seconds ago next to an older daemon tick',
    status({ running: { pid: 4242, since: '2026-11-02T11:59:30.000Z' }, lastTickAt: '2026-11-02T11:40:00.000Z' }),
    ['/app'],
    [],
  ],
  ['no daemon while a dev server runs', status({}), ['/app'], ['No stim-daemon runs while a dev server does']],
  ['no daemon and nothing running', status({}), [], []],
  ['daemon.mode off while a dev server runs', status({ mode: 'off' }), ['/app'], []],
  [
    'a claim that cannot be resolved',
    status({
      mode: 'off',
      claim: { unresolved: '/home/daemon/claim/x: unreadable', removeCommand: 'rm /home/daemon/claim/x' },
    }),
    ['/app'],
    ['The stim-daemon claim cannot be resolved'],
  ],
])('doctor reports %s', (_, value, serving, expected) => {
  expect(titles(value, serving)).toEqual(expected);
});

test('the status line says whether the daemon runs and when it last ticked', () => {
  expect(daemonLine(status({ running, lastTickAt: '2026-11-02T11:59:30.000Z' }), NOW)).toMatch(
    /^Daemon \(on\): running since \d\d:\d\d \(pid 4242\), last tick 30s ago$/,
  );
  expect(daemonLine(status({}), NOW)).toMatch(/^Daemon \(on\): not running, no tick yet;/);
  expect(daemonLine(status({ mode: 'off' }), NOW)).toMatch(/^Daemon: off \(daemon\.mode\)/);
});

test('the last daemon action line names the newest action, its age and what it freed', () => {
  expect(lastActionLine(status({}), NOW)).toBe(null);
  const action = { rung: 1, kind: 'idle-stage', target: '/app', outcome: 'done' as const, bytes: 2048, detail: '' };
  expect(
    lastActionLine(
      status({
        recent: [
          { ...action, target: '/old', at: '2026-11-02T11:00:00.000Z' },
          { ...action, at: '2026-11-02T11:58:00.000Z' },
        ],
      }),
      NOW,
    ),
  ).toMatch(/^Last daemon action 2m ago: idle stage \/app \(2K\); 2 recent in /);
});

test("status reports the running daemon's tick and mode, and the setting when the mode differs", () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-daemon-status-'));
  process.env.STIM_HOME = home;
  const claim = tryAcquireClaim({
    root: daemonClaimRoot(),
    mode: 'exclusive',
    label: 'stim-daemon',
    details: { mode: 'report' },
  }).acquired;
  onTestFinished(() => {
    if (claim) releaseClaim(claim);
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });
  expect(claim).toBeTruthy();
  mkdirSync(daemonDir(), { recursive: true });
  const snapshot = (pid: number, mode: string) =>
    writeFileSync(
      daemonSnapshotFile(),
      JSON.stringify({
        version: 1,
        pid,
        mode,
        startedAt: '2026-11-02T11:00:00.000Z',
        tickAt: '2026-11-02T11:01:00.000Z',
        intervalMs: 60_000,
      }),
    );

  snapshot(process.pid + 1, 'on');
  const fresh = daemonStatus({});
  expect(fresh).toMatchObject({ mode: 'report', setting: 'on', running: { pid: process.pid }, lastTickAt: null });
  expect(daemonLine(fresh, NOW)).toMatch(/^Daemon \(report only; daemon\.mode resolves to on here\): running since/);
  snapshot(process.pid, 'off');
  expect(daemonStatus({})).toMatchObject({ mode: 'off', setting: 'on', lastTickAt: '2026-11-02T11:01:00.000Z' });
  snapshot(process.pid, 'on');
  expect(daemonStatus({ STIM_DAEMON: 'on' })).not.toHaveProperty('setting');
  releaseClaim(claim!);
  const recent = [{ rung: 4, kind: 'dormant-stage', target: '/app', outcome: 'done', bytes: 0, detail: '', at: NOW }];
  writeFileSync(
    daemonSnapshotFile(),
    JSON.stringify({
      ...JSON.parse('{}'),
      version: 1,
      pid: 1,
      mode: 'on',
      startedAt: 'x',
      tickAt: 'y',
      intervalMs: 60_000,
      recent,
    }),
  );
  expect(daemonStatus({})).toMatchObject({ running: null, recent });
});
