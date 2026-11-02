import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClaimRoot, daemonDir, daemonSnapshotFile, type DaemonStatus } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { daemonFindings, daemonLine, daemonStatus } from '../daemon/status.ts';

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

test("a snapshot another daemon wrote is not the running daemon's tick", () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-daemon-status-'));
  process.env.STIM_HOME = home;
  const claim = tryAcquireClaim({ root: daemonClaimRoot(), mode: 'exclusive', label: 'stim-daemon' }).acquired;
  onTestFinished(() => {
    if (claim) releaseClaim(claim);
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });
  expect(claim).toBeTruthy();
  mkdirSync(daemonDir(), { recursive: true });
  const snapshot = (pid: number) =>
    writeFileSync(
      daemonSnapshotFile(),
      JSON.stringify({
        version: 1,
        pid,
        startedAt: '2026-11-02T11:00:00.000Z',
        tickAt: '2026-11-02T11:01:00.000Z',
        intervalMs: 60_000,
      }),
    );

  snapshot(process.pid + 1);
  expect(daemonStatus({})).toMatchObject({ running: { pid: process.pid }, lastTickAt: null });
  snapshot(process.pid);
  expect(daemonStatus({})).toMatchObject({ running: { pid: process.pid }, lastTickAt: '2026-11-02T11:01:00.000Z' });
});
