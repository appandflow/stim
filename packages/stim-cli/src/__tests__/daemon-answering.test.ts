import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonStatus } from '@stim-cli/core/state';
import { probeDaemonAnswer, unansweredFindings, withAnswer } from '../daemon/answering.ts';
import { daemonLine, daemonStatus } from '../daemon/status.ts';
import { holdDaemonClaim, serveStimdSocket } from './_stimd-socket.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const running = { pid: 4242, since: '2026-11-02T11:00:00.000Z' };
const status = (over: Partial<DaemonStatus> = {}): DaemonStatus => ({
  mode: 'on',
  running,
  lastTickAt: '2026-11-02T11:55:00.000Z',
  intervalMs: 60_000,
  ...over,
});

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'stim-answering-'));
  process.env.STIM_HOME = home;
  onTestFinished(() => {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });
});

describe('probeDaemonAnswer', () => {
  const claimed = (): DaemonStatus => {
    holdDaemonClaim();
    return daemonStatus();
  };

  test('reports nothing for a stimd that replies', async () => {
    const held = claimed();
    await serveStimdSocket('{"op":"probe","pid":1}');
    expect(await probeDaemonAnswer(held)).toEqual({});
  });

  test('counts the unknown-kind error of an older stimd as a reply', async () => {
    const held = claimed();
    await serveStimdSocket('{"op":"error","code":"unknown-kind"}');
    expect(await probeDaemonAnswer(held)).toEqual({});
  });

  test('reports nothing and does not connect when no stimd holds the claim', async () => {
    expect(await probeDaemonAnswer(status({ running: null }))).toEqual({});
  });

  test('reports a stimd that accepts the connection and sends no reply within 3 s', async () => {
    const held = claimed();
    await serveStimdSocket(null);
    const probe = probeDaemonAnswer(held);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await probe).toEqual({ unanswered: { pid: process.pid, waitedMs: 3000 } });
  });

  test('drops a failed probe when the claim holder is no longer the one it was taken against', async () => {
    claimed();
    await serveStimdSocket(null);
    const probe = probeDaemonAnswer(status({ running: { pid: process.pid, since: '2026-01-01T00:00:00.000Z' } }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await probe).toEqual({});
  });

  test.skipIf(process.platform === 'win32')(
    'names a missing socket file (a Windows named pipe has no file)',
    async () => {
      const held = claimed();
      const probe = probeDaemonAnswer(held);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await probe).toEqual({ unanswered: { pid: process.pid, waitedMs: 3000, socketMissing: true } });
    },
  );
});

test('a probe result is only joined to the status of the stimd it was taken against', () => {
  const answer = { unanswered: { pid: 4242, waitedMs: 3000 } };
  expect(withAnswer(status(), answer).unanswered).toEqual(answer.unanswered);
  expect(withAnswer(status({ running: { ...running, pid: 77 } }), answer)).not.toHaveProperty('unanswered');
  expect(withAnswer(status({ running: null }), answer)).not.toHaveProperty('unanswered');
});

describe('a stimd that holds the claim and did not answer', () => {
  const silent = status({ unanswered: { pid: 4242, waitedMs: 3000 } });

  test('the daemon line says it as an observation with the last tick age', () => {
    expect(daemonLine(silent, NOW)).toMatch(
      /^Daemon \(on\): holds the claim since \d\d:\d\d \(pid 4242\), did not answer within 3 s, last tick 5m ago/,
    );
    expect(daemonLine({ ...silent, unanswered: { pid: 4242, waitedMs: 3000, socketMissing: true } }, NOW)).toContain(
      'did not answer within 3 s (its socket file is missing)',
    );
  });

  test('the doctor finding has a code and names the pid and the tick age', () => {
    const [finding, ...rest] = unansweredFindings(silent, NOW);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ code: 'stimd-not-answering', level: 'cost' });
    expect(finding?.detail).toContain('pid 4242 did not answer within 3 s');
    expect(finding?.detail).toContain('last tick was 5m ago');
  });

  test('the fix names kill with the claim pid only when the last tick is also late', () => {
    const recent = status({ unanswered: { pid: 4242, waitedMs: 3000 }, lastTickAt: '2026-11-02T11:59:00.000Z' });
    expect(unansweredFindings(recent, NOW)[0]?.fix).not.toMatch(/kill/);
    expect(unansweredFindings(silent, NOW)[0]?.fix).toContain('`kill 4242`');
  });

  test('a stimd that answered gets no finding and the usual line', () => {
    expect(unansweredFindings(status(), NOW)).toEqual([]);
    expect(daemonLine(status(), NOW)).toMatch(
      /^Daemon \(on\): running since \d\d:\d\d \(pid 4242\), last tick 5m ago$/,
    );
  });
});
