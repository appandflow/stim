import type { SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText } from '../ndjson.ts';
import { startCommandServer } from '../supervisor/server-command.ts';
import { makeChildProcess } from './_factories.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-command-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const command = ['node', '../react-native/cli.js', 'start', '--port', '{port}'];

describe('startCommandServer', () => {
  test('runs the argv from the app directory with {port} replaced, as its own process group off Windows', async () => {
    const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    const spawnFn = (cmd: string, args: string[], opts: SpawnOptions) => {
      calls.push({ cmd, args, opts });
      return makeChildProcess({ pid: 4242 });
    };
    const logsDir = join(root, 'logs');
    await startCommandServer({ root, port: 8095, logsDir, command, spawnFn, platform: 'darwin' });
    await startCommandServer({ root, port: 8095, logsDir, command, spawnFn, platform: 'win32' });

    expect(calls[0]?.cmd).toBe('node');
    expect(calls[0]?.args).toEqual(['../react-native/cli.js', 'start', '--port', '8095']);
    expect(calls[0]?.opts.cwd).toBe(root);
    expect(calls[0]?.opts.detached).toBe(true);
    expect(calls[1]?.opts.detached).toBe(false);
  });

  test('its output becomes raw command records with inferred levels and bundle markers', async () => {
    const child = makeChildProcess({ pid: 4242 });
    const logsDir = join(root, 'logs');
    await startCommandServer({ root, port: 8096, logsDir, command, spawnFn: () => child });
    child.stdout!.emit('data', 'iOS Bundled 812ms js/RNTesterApp.ios.js (1204 modules)\n');
    child.stderr!.emit('data', 'error: Unable to resolve module ./Missing\n');

    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8')).filter(
      (r) => !String(r.event).startsWith('cache_store_'),
    );
    expect(records).toMatchObject([
      { src: 'metro', level: 'info', raw: true, event: 'command_stdout', marker: true },
      { src: 'metro', level: 'error', raw: true, event: 'command_stderr' },
    ]);
  });

  test('close signals the whole group and escalates to SIGKILL when it does not exit', async () => {
    const child = makeChildProcess({ pid: 4242 });
    const signals: [number, NodeJS.Signals, unknown][] = [];
    const server = await startCommandServer({
      root,
      port: 8097,
      logsDir: join(root, 'logs'),
      command,
      spawnFn: () => child,
      platform: 'darwin',
      killTimeoutMs: 1,
      signalTree: (pid, sig, opts) => {
        signals.push([pid, sig as NodeJS.Signals, opts]);
        return true;
      },
    });
    await server.close();

    expect(signals).toEqual([
      [4242, 'SIGTERM', { group: true, platform: 'darwin' }],
      [4242, 'SIGKILL', { group: true, platform: 'darwin' }],
    ]);
  });
});
