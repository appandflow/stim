import type { SpawnOptions } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import { startCommandServer } from '../supervisor/server-command.ts';
import { startExpoServer } from '../supervisor/server-expo.ts';
import { makeChildProcess, makeExecutor } from './_factories.ts';

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
});

test.each(['expo', 'command'] as const)(
  '%s Metro uses the nearest installed Node pin within its repository boundary',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-metro-node-'));
    try {
      const repo = join(dir, 'repo');
      const root = join(repo, 'apps', 'mobile');
      const nvm = join(dir, 'nvm');
      const bins = ['1.2.0', '2.0.0'].map((version) => join(nvm, 'versions', 'node', `v${version}`, 'bin'));
      for (const bin of bins) {
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'node'), '');
      }
      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      const expo = join(root, 'node_modules', '.bin', 'expo');
      writeFileSync(expo, '#!/bin/sh\n');
      chmodSync(expo, 0o755);
      writeFileSync(join(repo, '.git'), 'gitdir: ../worktrees/mobile\n');
      writeFileSync(join(repo, '.nvmrc'), '1.2.0\n');
      vi.stubEnv('NVM_DIR', nvm);
      vi.stubEnv('STIM_HOME', join(dir, 'stim-home'));
      setExecutor(makeExecutor({ runFileQuiet: () => '99.0.0' }));
      let childPath: string | undefined;
      const spawnFn = (_command: string, _args: string[], options: SpawnOptions) => {
        childPath = options.env?.PATH;
        return makeChildProcess();
      };
      const start = () => {
        const options = { root, port: 8095, logsDir: join(dir, 'logs'), spawnFn, platform: 'darwin' as const };
        return mode === 'expo'
          ? startExpoServer(options)
          : startCommandServer({ ...options, command: ['node', 'metro.js', '--port', '{port}'] });
      };

      await start();
      expect(childPath?.split(delimiter)[0]).toBe(bins[0]);
      writeFileSync(join(root, '.node-version'), '2.0.0\n');
      await start();
      expect(childPath?.split(delimiter)[0]).toBe(bins[1]);
      rmSync(join(root, '.node-version'));
      rmSync(join(repo, '.nvmrc'));
      writeFileSync(join(dir, '.nvmrc'), '1.2.0\n');
      await start();
      expect(childPath).toBe(process.env.PATH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
