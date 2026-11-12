import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCHD_TEST_GUARD_ENV } from '../../packages/stim-cli/src/daemon/launchd-guard-env.ts';
import { killRunProcesses } from '../../vitest.kill-run-processes.ts';
import { launchdJobsUnder, removeLaunchdLeftovers } from '../../vitest.launchd-leftovers.ts';

process.env.STIM_DAEMON = 'off';
process.env[LAUNCHD_TEST_GUARD_ENV] = '1';
process.env.STIM_ENGINE_ROOT = join(tmpdir(), 'stim-e2e-engine-absent');

if (process.platform !== 'win32') {
  // macOS gets /tmp because its default TMPDIR is long enough that Unix sockets under it exceed sun_path.
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'stim-e2e-run-'));
  process.env.TMPDIR = root;
  process.on('exit', () => {
    const { survivors: stimds, checked } = killRunProcesses(root);
    const jobs = launchdJobsUnder(root);
    rmSync(root, { recursive: true, force: true });
    if (!checked)
      process.stderr.write('Leftover stimd processes could not be checked: the process table was unreadable.\n');
    if (jobs.length > 0) {
      process.stderr.write(
        `This test file left ${jobs.length} stimd launchd job(s) registered (${removeLaunchdLeftovers(jobs)}); it removed them.\n`,
      );
      process.exitCode = 1;
    }
    if (stimds.length === 0) return;
    process.stderr.write(
      `This test file left ${stimds.length} stimd running (${stimds.map(({ pid, home }) => `${pid} serving ${home}`).join('; ')}); it stopped them.\n`,
    );
    process.exitCode = 1;
  });
}
