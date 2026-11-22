import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonClaimRoot,
  daemonDir,
  daemonSnapshotFile,
  legacyDaemonSocket,
  type DaemonStatus,
} from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { legacyDaemonStop } from '../daemon/legacy-daemon.ts';
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

describe('a late tick', () => {
  const late = status({ running, lastTickAt: '2026-11-02T11:56:00.000Z' });
  const findings = (value: DaemonStatus, probed?: boolean) =>
    daemonFindings(value, { now: NOW, serving: () => [], ...(probed === undefined ? {} : { probed }) });

  test.each<[string, Partial<DaemonStatus>, number]>([
    ['exactly three intervals old', { lastTickAt: '2026-11-02T11:57:00.000Z' }, 0],
    ['one millisecond over three intervals', { lastTickAt: '2026-11-02T11:56:59.999Z' }, 1],
    ['newer than now', { lastTickAt: '2026-11-02T12:00:05.000Z' }, 0],
    [
      'a claim started after now, with an old tick',
      { lastTickAt: '2026-11-02T11:00:00.000Z', running: { pid: 4242, since: '2026-11-02T12:00:30.000Z' } },
      0,
    ],
  ])('with a tick %s reports %i late finding', (_name, over, count) => {
    expect(findings(status({ running, ...over }), true)).toHaveLength(count);
  });

  test('of a stimd that answered the probe is reported as late, with no kill', () => {
    const [finding, ...rest] = findings(late, true);
    expect(rest).toEqual([]);
    expect(finding?.title).toBe('The stim-daemon is late with its ticks');
    expect(`${finding?.detail} ${finding?.fix}`).not.toMatch(/kill/);
  });

  test('of a stimd that did not answer leaves the finding to the not-answering one', () => {
    const silent = { ...late, unanswered: { pid: 4242, waitedMs: 3000 } };
    expect(findings(silent, true)).toEqual([]);
    expect(findings(silent)).toEqual([]);
  });

  test('of a stimd nobody probed keeps the stopped-ticking finding with its kill', () => {
    const [finding, ...rest] = findings(late);
    expect(rest).toEqual([]);
    expect(finding?.title).toBe('The stim-daemon has stopped ticking');
    expect(finding?.fix).toContain('`kill 4242`');
  });
});

test.each<[string, DaemonStatus, string[], string[]]>([
  [
    'a crash hold',
    status({ crashHold: { build: 'b', count: 3, until: '2026-11-02T12:05:00.000Z', remedy: 'fix it' } }),
    [],
    ['stimd is held after a crash loop'],
  ],
  [
    'an abnormal exit with no hold',
    status({
      abnormalExits: [{ at: '2026-11-02T10:00:00.000Z', build: 'b', pid: 1, reason: 'killed', cause: 'unknown' }],
    }),
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
    mode: 'shared',
    label: 'stimd',
    details: { mode: 'report' },
  }).acquired;
  onTestFinished(() => {
    if (claim) releaseClaim(claim);
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });
  expect(claim).toBeTruthy();
  mkdirSync(daemonDir(), { recursive: true });
  const snapshot = (pid: number, mode: string, gcMarks?: DaemonStatus['gcMarks']) =>
    writeFileSync(
      daemonSnapshotFile(),
      JSON.stringify({
        version: 1,
        pid,
        mode,
        startedAt: '2026-11-02T11:00:00.000Z',
        tickAt: '2026-11-02T11:01:00.000Z',
        intervalMs: 60_000,
        ...(gcMarks ? { gcMarks } : {}),
      }),
    );

  const gcMarks: NonNullable<DaemonStatus['gcMarks']> = {
    at: NOW,
    state: 'ready',
    checkedRoots: 0,
    staleCount: 0,
    stale: [],
  };
  snapshot(process.pid + 1, 'on', gcMarks);
  const fresh = daemonStatus({});
  expect(fresh).toMatchObject({ mode: 'report', setting: 'on', running: { pid: process.pid }, lastTickAt: null });
  expect(fresh).not.toHaveProperty('gcMarks');
  expect(daemonLine(fresh, NOW)).toMatch(/^Daemon \(report only; daemon\.mode resolves to on here\): running since/);
  snapshot(process.pid, 'off');
  expect(daemonStatus({})).not.toHaveProperty('gcMarks');
  snapshot(process.pid, 'off', gcMarks);
  expect(daemonStatus({})).toMatchObject({ gcMarks });
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

describe('an exclusive holder of the daemon claim', () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-daemon-status-'));
    process.env.STIM_HOME = dir;
    onTestFinished(() => {
      delete process.env.STIM_HOME;
      rmSync(dir, { recursive: true, force: true });
    });
  };

  test.each([
    [
      'a stim-daemon record',
      () => ({ socket: legacyDaemonSocket(), mode: 'on' }),
      true,
      'the next command that starts stimd stops it',
    ],
    [
      'another record',
      () => ({ mode: 'on' }),
      false,
      `stimd does not stop it, so run ${legacyDaemonStop(process.pid)}`,
    ],
  ])(
    'with %s is reported as an older daemon, not as the running one, without its snapshot',
    (_name, makeDetails, verified, line) => {
      home();
      const claim = tryAcquireClaim({
        root: daemonClaimRoot(),
        mode: 'exclusive',
        label: 'stim-daemon',
        details: makeDetails(),
      }).acquired;
      onTestFinished(() => {
        releaseClaim(claim);
      });
      mkdirSync(daemonDir(), { recursive: true });
      writeFileSync(
        daemonSnapshotFile(),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          mode: 'on',
          startedAt: '2026-11-02T11:00:00.000Z',
          tickAt: '2026-11-02T11:01:00.000Z',
          intervalMs: 60_000,
          pressure: { level: 'high', disk: {}, memory: {}, reasons: [] },
        }),
      );

      const older = daemonStatus({});

      expect(older).toMatchObject({ running: null, older: { pid: process.pid, verified }, lastTickAt: null });
      expect(older).not.toHaveProperty('pressure');
      expect(daemonLine(older, NOW)).toContain(`pid ${process.pid} from an older stim holds the daemon claim`);
      expect(daemonLine(older, NOW)).toContain(line);
      const findings = daemonFindings(older, { now: NOW, serving: () => ['/app'] });
      expect(findings.map((finding) => finding.title)).toEqual([
        'A stim-daemon from an older Stim holds the daemon claim',
      ]);
      expect(findings[0]?.fix).toContain(legacyDaemonStop(process.pid));
    },
  );

  test('beside a live shared claim, which a pending 1.40 attempt leaves, the shared claim is the running daemon', () => {
    home();
    const shared = tryAcquireClaim({ root: daemonClaimRoot(), mode: 'shared', label: 'stimd' }).acquired;
    onTestFinished(() => {
      releaseClaim(shared);
    });
    const attempt = tryAcquireClaim({
      root: daemonClaimRoot(),
      mode: 'exclusive',
      label: 'stim-daemon',
      details: { socket: legacyDaemonSocket(), mode: 'on' },
    });
    expect(attempt.pending).toBeDefined();
    onTestFinished(() => {
      releaseClaim(attempt.pending);
    });

    expect(daemonStatus({})).toMatchObject({ running: { pid: process.pid } });
    expect(daemonStatus({})).not.toHaveProperty('older');
  });
});
