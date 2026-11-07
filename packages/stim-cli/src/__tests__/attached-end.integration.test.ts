import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stimdRunDir } from '@stim-cli/core/state';
import { endAttached } from '../stimd/attached.ts';

vi.mock('../daemon/client.ts', () => ({
  launchStimd: vi.fn<() => void>(),
  stimdLive: vi.fn<() => boolean>(() => true),
}));

test.each([true, false])('journals an operation admitted during measurement (still running: %s)', async (running) => {
  const home = mkdtempSync(join(tmpdir(), 'stim-attached-end-'));
  vi.stubEnv('STIM_HOME', home);
  mkdirSync(stimdRunDir(), { recursive: true });
  let revision = 0;
  let ops: string[] = [];
  let released = false;
  try {
    await endAttached({
      inFlight: () => ops,
      admissionRevision: () => revision,
      alive: async () => {
        revision++;
        ops = running ? ['stim ios'] : [];
        return null;
      },
      waitMs: 0,
      handover: true,
      mode: () => 'off',
      identity: { build: 'test', version: 'test' },
      release: async () => {
        released = true;
      },
      successorArgs: () => [],
      log: () => {},
    });
    const journal = JSON.parse(readFileSync(join(stimdRunDir(), 'stimd-journal.json'), 'utf8'));
    expect(released).toBe(true);
    expect(journal.alive).toContain('command was admitted');
    expect(journal.unfinished).toEqual(ops);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

test('waits for cancelled measurement cleanup before releasing its home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-attached-end-'));
  vi.stubEnv('STIM_HOME', home);
  mkdirSync(stimdRunDir(), { recursive: true });
  vi.useFakeTimers();
  let cleanup: (() => void) | undefined;
  let released = false;
  try {
    const ending = endAttached({
      inFlight: () => [],
      admissionRevision: () => 0,
      alive: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            cleanup = () => reject(signal.reason);
          });
        }),
      waitMs: 0,
      handover: true,
      mode: () => 'off',
      identity: { build: 'test', version: 'test' },
      release: async () => {
        released = true;
      },
      successorArgs: () => [],
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(5200);
    expect(cleanup).toBeDefined();
    expect(released).toBe(false);
    if (!cleanup) throw new Error('measurement did not abort');
    cleanup();
    await ending;
    expect(released).toBe(true);
    expect(JSON.parse(readFileSync(join(stimdRunDir(), 'stimd-journal.json'), 'utf8')).alive).toContain('not measured');
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'stops a measurement subprocess before releasing its home',
  async () => {
    const { getExecutor } = await import('../exec.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-attached-probe-'));
    vi.stubEnv('STIM_HOME', home);
    mkdirSync(stimdRunDir(), { recursive: true });
    let pid = 0;
    let aliveAtRelease = true;
    try {
      await endAttached({
        inFlight: () => [],
        admissionRevision: () => 0,
        alive: async (signal) => {
          await getExecutor().runFileAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            signal,
            timeoutMs: 10_000,
            onSpawn: (child) => {
              pid = child.pid ?? 0;
            },
          });
          return null;
        },
        waitMs: 0,
        handover: true,
        mode: () => 'off',
        identity: { build: 'test', version: 'test' },
        release: async () => {
          try {
            process.kill(pid, 0);
          } catch {
            aliveAtRelease = false;
          }
        },
        successorArgs: () => [],
        log: () => {},
      });
      expect(pid).toBeGreaterThan(0);
      expect(aliveAtRelease).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
  15_000,
);
