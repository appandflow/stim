import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')(
  'retains a live executable path with spaces under the benchmark sandbox',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-bench-process-'));
    const executable = join(root, 'benchmark executable with spaces');
    const adapter = join(root, 'ps');
    let child;
    try {
      execFileSync(
        '/usr/bin/clang',
        [
          '-std=c11',
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          fileURLToPath(new URL('./compat/macos-processes.c', import.meta.url)),
          '-o',
          adapter,
        ],
        { timeout: 30_000 },
      );
      copyFileSync('/bin/sleep', executable);
      chmodSync(executable, 0o755);
      child = spawn(executable, ['60'], { stdio: 'ignore' });
      await once(child, 'spawn');
      const output = execFileSync(
        '/usr/bin/sandbox-exec',
        ['-p', '(version 1)(allow default)', adapter, '-axww', '-o', 'pid=,comm='],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(output.split('\n')).toContain(`${child.pid} ${realpathSync(executable)}`);
      expect(spawnSync(adapter, ['-axww', '-o', 'pid=,command='], { timeout: 10_000 }).status).toBe(2);
    } finally {
      if (child && child.exitCode == null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
