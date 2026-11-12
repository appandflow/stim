import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killRunProcesses } from '../../vitest.kill-run-processes.ts';

process.env.STIM_DAEMON = 'off';
process.env.STIM_ENGINE_ROOT = join(tmpdir(), 'stim-e2e-engine-absent');

if (process.platform !== 'win32') {
  // macOS gets /tmp because its default TMPDIR is long enough that Unix sockets under it exceed sun_path.
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'stim-e2e-run-'));
  process.env.TMPDIR = root;
  process.on('exit', () => {
    const stimds = killRunProcesses(root);
    rmSync(root, { recursive: true, force: true });
    if (stimds.length === 0) return;
    process.stderr.write(
      `This test file left ${stimds.length} stimd running (${stimds.map(({ pid, home }) => `${pid} serving ${home}`).join('; ')}); it stopped them.\n`,
    );
    process.exitCode = 1;
  });
}
