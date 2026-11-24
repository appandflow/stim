import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform === 'win32')(
  'the compiled helper policy enforces path, sustained usage, recovery, sample gaps and hourly limits',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-helper-policy-'));
    try {
      const executable = join(dir, 'policy');
      execFileSync('cc', [
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        executable,
        fileURLToPath(new URL('./fixtures/helper-policy.c', import.meta.url)),
      ]);
      execFileSync(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
