import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import { commandServerLaunch } from '../stimd/metro/server-command.ts';
import { expoServerLaunch } from '../stimd/metro/server-expo.ts';
import { repackServerLaunch } from '../stimd/metro/server-repack.ts';
import { makeExecutor, makeWriter } from './_factories.ts';

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
      const childPath = async () => {
        const options = { root, port: 8095, logsDir: join(dir, 'logs'), platform: 'darwin' as const };
        const launch =
          mode === 'expo'
            ? await expoServerLaunch(options)
            : commandServerLaunch({ ...options, command: ['node', 'metro.js', '--port', '{port}'] });
        return launch.env.PATH;
      };

      expect((await childPath())?.split(delimiter)[0]).toBe(bins[0]);
      writeFileSync(join(root, '.node-version'), '2.0.0\n');
      expect((await childPath())?.split(delimiter)[0]).toBe(bins[1]);
      rmSync(join(root, '.node-version'));
      rmSync(join(repo, '.nvmrc'));
      writeFileSync(join(dir, '.nvmrc'), '1.2.0\n');
      expect(await childPath()).toBe(process.env.PATH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each(['expo-package', 'expo-shim', 'repack'] as const)(
  'Windows %s reports which Node runs the server and where the pin applies',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'stim-metro-node-'));
    try {
      const nvm = join(root, 'nvm');
      const pinBin = join(nvm, 'versions', 'node', 'v1.2.0', 'bin');
      mkdirSync(pinBin, { recursive: true });
      writeFileSync(join(pinBin, 'node'), '');
      writeFileSync(join(root, '.nvmrc'), '1.2.0\n');
      vi.stubEnv('NVM_DIR', nvm);
      vi.stubEnv('STIM_HOME', join(root, 'stim-home'));
      setExecutor(makeExecutor({ runFileQuiet: () => '99.0.0' }));

      if (mode === 'expo-shim') {
        const shim = join(root, 'node_modules', '.bin', 'expo');
        mkdirSync(join(shim, '..'), { recursive: true });
        writeFileSync(shim, '#!/bin/sh\n');
      } else {
        const name = mode === 'repack' ? 'rock' : 'expo';
        const pkg = join(root, 'node_modules', name);
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, bin: './bin.js' }));
        writeFileSync(join(pkg, 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
      }
      if (mode === 'repack') {
        writeFileSync(
          join(root, 'rock.config.mjs'),
          "import { pluginRepack } from '@rock-js/plugin-repack';\nexport default { bundler: pluginRepack() };\n",
        );
        const repack = join(root, 'node_modules', '@callstack', 'repack');
        mkdirSync(repack, { recursive: true });
        writeFileSync(join(repack, 'package.json'), '{"name":"@callstack/repack","version":"5.4.1"}');
      }

      const write = vi.fn<() => boolean>(() => true);
      const options = {
        root,
        port: 8095,
        logsDir: join(root, 'logs'),
        platform: 'win32' as const,
        writer: makeWriter({ write }),
      };
      const launch = mode === 'repack' ? repackServerLaunch(options) : await expoServerLaunch(options);
      expect(launch.env.PATH?.split(delimiter)[0]).toBe(pinBin);
      const pinned = `Node 1.2.0 from ${pinBin}, for .nvmrc 1.2.0`;
      const server = mode === 'repack' ? 'Re.Pack' : 'Metro';
      const ownNode = mode !== 'expo-shim';
      const command = ownNode ? process.execPath : join(root, 'node_modules', '.bin', 'expo');
      const message = ownNode
        ? `${server} runs on Stim's Node ${process.versions.node} at ${process.execPath}. Child processes find ${pinned} on PATH.`
        : `Metro runs on ${pinned}`;
      expect(launch.command).toBe(command);
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ event: 'project_node', msg: message }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
