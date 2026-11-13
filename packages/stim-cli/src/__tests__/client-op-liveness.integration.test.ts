import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { livenessChild } from './_op-liveness-child.ts';

/**
 * @ref LLP 0012#a-command-continues-across-a-stimd-restart -- a command waiting on stimd stays alive until its wait ends
 */
test.skipIf(process.platform === 'win32')(
  'a command waiting on a stimd that stopped answering settles instead of exiting silently',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-op-liveness-')));
    let output = '';
    try {
      const child = spawn(process.execPath, [livenessChild, '18996'], {
        env: { ...process.env, STIM_HOME: home },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      const [code] = await once(child, 'exit');
      expect({ code, output }).toMatchObject({ code: 0, output: expect.stringContaining('settled') });
    } finally {
      const pid = /stimd (\d+)/.exec(output)?.[1];
      if (pid) {
        for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
          try {
            process.kill(Number(pid), signal);
          } catch {}
        }
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    }
  },
  60_000,
);
