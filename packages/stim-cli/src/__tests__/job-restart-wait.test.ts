import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitJobRestart, connectNet } from '../daemon/client.ts';
import { writeJobRestart } from '../stimd/job-restart.ts';

describe('the wait on a service job restart', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-job-restart-'));
    mkdirSync(join(home, 'run'), { recursive: true });
    vi.stubEnv('STIM_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not wait on the record of the stimd that is leaving, so its own share lookups finish its shutdown', async () => {
    writeJobRestart({ at: Date.now(), pid: process.pid, label: 'dev.stim.server', left: null });
    await expect(awaitJobRestart()).resolves.toBeUndefined();
  });

  it('does not hold a net client on a record whose window has passed', async () => {
    writeJobRestart({
      at: Date.now() - 10 * 60_000,
      pid: 999_999_999,
      label: 'dev.stim.server',
      left: Date.now() - 5 * 60_000,
    });
    await expect(connectNet(3000)).resolves.toBeNull();
  });
});
