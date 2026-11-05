import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { getExecutor } from '../exec.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-detached-entry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'win32')(
  'the Windows launcher starts an entry from a path with brackets and a smart quote',
  async () => {
    const cwd = join(dir, '[O\u2019Brien]');
    mkdirSync(cwd);
    const entry = join(cwd, 'entry.cjs');
    const marker = join(dir, 'started.txt');
    // Windows refuses to remove a live process's working directory, and the detached entry may
    // still be exiting when the marker appears, so it leaves `cwd` before writing the marker, and
    // renames the marker into place so the test never deletes it while its write handle is open.
    writeFileSync(
      entry,
      [
        "const fs = require('node:fs');",
        'const cwd = process.cwd();',
        "process.chdir(require('node:os').tmpdir());",
        "fs.writeFileSync(process.env.STIM_LAUNCH_MARKER + '.tmp', cwd);",
        "fs.renameSync(process.env.STIM_LAUNCH_MARKER + '.tmp', process.env.STIM_LAUNCH_MARKER);",
      ].join('\n'),
    );
    const launcher = windowsLauncherArgs({ entry, args: [], cwd, logFile: join(cwd, 'supervisor.log') });
    const result = getExecutor().runFile(launcher.file, launcher.args, {
      cwd: dir,
      env: { ...launcher.env, STIM_LAUNCH_MARKER: marker },
      timeoutMs: 60_000,
    });
    expect(result).toBe('');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(marker, 'utf8').toLowerCase()).toBe(cwd.toLowerCase());
  },
  75_000,
);
