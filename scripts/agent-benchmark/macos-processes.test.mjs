import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const compile = (source, output) =>
  execFileSync('/usr/bin/clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output], {
    timeout: 30_000,
  });

it.skipIf(process.platform !== 'darwin')(
  'retains the path of a live process with spaces or an unlinked executable under the benchmark sandbox',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-bench-process-')));
    const executable = join(root, 'benchmark executable with spaces');
    const adapter = join(root, 'ps');
    let child;
    try {
      compile(fileURLToPath(new URL('./compat/macos-processes.c', import.meta.url)), adapter);
      const sleeper = join(root, 'sleeper.c');
      writeFileSync(sleeper, '#include <unistd.h>\nint main(void) { sleep(60); return 0; }\n');
      compile(sleeper, executable);
      child = spawn(executable, [], { stdio: 'ignore' });
      await once(child, 'spawn');
      const listing = () =>
        execFileSync(
          '/usr/bin/sandbox-exec',
          ['-p', '(version 1)(allow default)', adapter, '-axww', '-o', 'pid=,comm='],
          {
            encoding: 'utf8',
            timeout: 10_000,
          },
        ).split('\n');
      expect(listing()).toContain(`${child.pid} ${executable}`);
      rmSync(executable);
      expect(listing()).toContain(`${child.pid} ${executable}`);
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
