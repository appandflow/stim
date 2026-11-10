import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const pkg = join(repo, 'packages/stim-cli');

test(
  'an engine switch detected in a foreground tick starts a successor that binds',
  { skip: process.platform !== 'darwin', timeout: 45_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'stim-tick-switch-'));
    const home = join(scratch, 'home');
    const store = join(scratch, 'engine');
    const bin = join(scratch, 'bin');
    const started = join(scratch, 'probe-started');
    const release = join(scratch, 'probe-release');
    const { stimBuildId } = await import(pathToFileURL(join(repo, 'packages/core/dist/state.mjs')).href);
    mkdirSync(store, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'vm_stat'),
      `#!/bin/sh\ntouch ${JSON.stringify(started)}\nwhile [ ! -e ${JSON.stringify(release)} ]; do sleep 0.05; done\nprintf 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages free: 1.\\nPages inactive: 1.\\nPages speculative: 1.\\n'\n`,
      { mode: 0o755 },
    );
    const makeBuild = (name, changed) => {
      const dir = join(store, name);
      mkdirSync(dir);
      cpSync(join(pkg, 'dist'), join(dir, 'dist'), { recursive: true });
      if (changed) writeFileSync(join(dir, 'dist', 'tick-switch-fixture.mjs'), 'export {};\n');
      cpSync(join(pkg, 'package.json'), join(dir, 'package.json'));
      symlinkSync(join(pkg, 'node_modules'), join(dir, 'node_modules'), 'junction');
      const id = stimBuildId(join(dir, 'dist'));
      assert.ok(id);
      renameSync(dir, join(store, id));
      return id;
    };
    const first = makeBuild('first', false);
    const next = makeBuild('second', true);
    const pointer = join(store, 'current.json');
    writeFileSync(pointer, JSON.stringify({ format: 1, dir: first, version: 'first' }));
    const env = {
      ...process.env,
      STIM_HOME: home,
      STIM_ENGINE_ROOT: store,
      STIM_DAEMON: 'on',
      STIM_NO_UPDATE_CHECK: '1',
      PATH: `${bin}:${process.env.PATH}`,
    };
    const child = spawn(process.execPath, [join(store, first, 'dist', 'cli.mjs'), '__stimd', '--mode', 'on'], {
      env,
      stdio: 'ignore',
    });
    let successor;
    const until = async (description, check, timeout = 20_000) => {
      for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
        const result = await check();
        if (result) return result;
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.fail(`timed out waiting for ${description}`);
    };
    const record = () => {
      try {
        return JSON.parse(readFileSync(join(home, 'run', 'stimd.json'), 'utf8'));
      } catch {
        return null;
      }
    };
    try {
      const initial = await until('first daemon', () => record());
      const socket = connect(initial.socket);
      socket.on('error', () => {});
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ kind: 'cli', build: initial.build })}\n${JSON.stringify({ op: 'tick' })}\n`),
      );
      socket.resume();
      await until('foreground probe', () => existsSync(started));
      writeFileSync(pointer, JSON.stringify({ format: 1, dir: next, version: 'next' }));
      writeFileSync(release, '');
      successor = await until('successor daemon', () => {
        const current = record();
        return current?.pid !== initial.pid && current?.build === next ? current : null;
      });
      await new Promise((done, reject) => {
        const client = connect(successor.socket);
        client.once('connect', () => {
          client.destroy();
          done();
        });
        client.once('error', reject);
      });
      socket.destroy();
    } finally {
      writeFileSync(release, '');
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      const remaining = record();
      if (!successor && remaining?.pid !== child.pid) successor = remaining;
      if (successor?.pid) {
        try {
          process.kill(successor.pid, 'SIGTERM');
        } catch {}
        await until('successor to exit', () => {
          try {
            process.kill(successor.pid, 0);
            return false;
          } catch {
            return true;
          }
        });
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
