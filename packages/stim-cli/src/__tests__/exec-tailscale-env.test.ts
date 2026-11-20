import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { getExecutor, resetExecutor } from '../exec.ts';

describe.skipIf(process.platform === 'win32')('CLI Tailscale environment', () => {
  test.each([undefined, '', 'xterm-256color'])(
    'Tailscale children get a CLI environment when the caller TERM is %j',
    async (term) => {
      resetExecutor();
      const dir = mkdtempSync(join(tmpdir(), 'stim-cli-tailscale-env-'));
      const file = join(dir, 'Tailscale');
      writeFileSync(file, '#!/usr/bin/env node\nprocess.stdout.write(process.env.TERM ?? "missing");\n', {
        mode: 0o755,
      });
      const env = { PATH: process.env.PATH, TERM: term };
      const context = {
        home: dir,
        buildCache: null,
        projectRoot: dir,
        cwd: dir,
        runId: 'tailscale-env',
        env,
        signal: new AbortController().signal,
        output: () => {},
      };
      try {
        await withAmbientContext(context, async () => {
          const executor = getExecutor();
          const expected = term || 'dumb';
          expect(executor.runFile(file, [], { timeoutMs: 5000 })).toBe(expected);
          expect(await executor.runFileAsync(file, [], { timeoutMs: 5000 })).toBe(expected);
          const spawned = await new Promise<string>((resolve, reject) => {
            const child = executor.spawn(file, [], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
            child.on('error', reject);
            child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`Exit ${code}`))));
          });
          expect(spawned).toBe(expected);
          expect(
            executor.runFile(process.execPath, ['-e', 'process.stdout.write(process.env.TERM ?? "missing")'], {
              timeoutMs: 5000,
            }),
          ).toBe(term ?? 'missing');
          expect(env.TERM).toBe(term);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
