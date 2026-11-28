import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform === 'win32')(
  'the compiled helper policy converts Mach ticks and enforces path, sustained usage, recovery, sample gaps and hourly limits',
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

test.runIf(process.platform === 'darwin')(
  'helper files tolerate hard links, restore cooldowns after rotation retry and atomically replace health',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-helper-files-'));
    try {
      const executable = join(dir, 'files');
      execFileSync('cc', [
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        executable,
        fileURLToPath(new URL('./fixtures/helper-files.c', import.meta.url)),
      ]);
      execFileSync(executable, [dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === 'darwin')(
  'helper retries process listing, rotation, write and sync failures in-process and recovers its heartbeat',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-helper-retry-'));
    try {
      const executable = join(dir, 'retry');
      execFileSync('cc', [
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        executable,
        fileURLToPath(new URL('./fixtures/helper-retry.c', import.meta.url)),
      ]);
      execFileSync(executable, [dir], { timeout: 5000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === 'darwin')(
  'helper exits once a replaced executable settles, and keeps running while the path is missing or still being written',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-helper-update-'));
    try {
      const executable = join(dir, 'update');
      execFileSync('cc', [
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        executable,
        fileURLToPath(new URL('./fixtures/helper-update.c', import.meta.url)),
      ]);
      execFileSync(executable, [dir], { timeout: 5000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
