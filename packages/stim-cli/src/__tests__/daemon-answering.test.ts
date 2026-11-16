import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonStatus } from '@stim-cli/core/state';
import { probeDaemonAnswer, unansweredFindings } from '../daemon/answering.ts';
import { daemonLine } from '../daemon/status.ts';
import { serveStimdSocket } from './_stimd-socket.ts';

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
  test('reports nothing for a stimd that replies to the hello', async () => {
    await serveStimdSocket('{"op":"hello"}');
    expect(await probeDaemonAnswer(status())).toEqual({});
  });

  test('reports nothing and does not connect when no stimd holds the claim', async () => {
    expect(await probeDaemonAnswer(status({ running: null }))).toEqual({});
  });

  test('reports a stimd that accepts the connection and sends no reply within 3 s', async () => {
    await serveStimdSocket(null);
    const probe = probeDaemonAnswer(status());
    await vi.advanceTimersByTimeAsync(3000);
    expect(await probe).toEqual({ unanswered: { pid: 4242, waitedMs: 3000 } });
  });

  test.skipIf(process.platform === 'win32')(
    'names a missing socket file (a Windows named pipe has no file)',
    async () => {
      const probe = probeDaemonAnswer(status());
      await vi.advanceTimersByTimeAsync(3000);
      expect(await probe).toEqual({ unanswered: { pid: 4242, waitedMs: 3000, socketMissing: true } });
    },
  );
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

  test('the doctor finding has a code, names the pid and the tick age, and never says to kill it', () => {
    const [finding, ...rest] = unansweredFindings(silent, NOW);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ code: 'stimd-not-answering', level: 'cost' });
    expect(finding?.detail).toContain('pid 4242 did not answer within 3 s');
    expect(finding?.detail).toContain('last tick was 5m ago');
    expect(`${finding?.detail} ${finding?.fix}`).not.toMatch(/kill|rm |remove/i);
  });

  test('a stimd that answered gets no finding and the usual line', () => {
    expect(unansweredFindings(status(), NOW)).toEqual([]);
    expect(daemonLine(status(), NOW)).toMatch(
      /^Daemon \(on\): running since \d\d:\d\d \(pid 4242\), last tick 5m ago$/,
    );
  });
});
