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
