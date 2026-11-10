import assert from 'node:assert';
import { once } from 'node:events';
import { getExecutor } from '../exec.ts';
import { processGroupAlive } from '../ownership-claim.ts';
import type { SpawnOptions } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText } from '../ndjson.ts';
import { startCommandServer } from '../stimd/metro/server-command.ts';
import { openChildOutput } from '../stimd/metro/child-server.ts';
import { makeChildProcess } from './_factories.ts';
import * as identity from '../process-identity.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-command-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const command = ['node', '../react-native/cli.js', 'start', '--port', '{port}'];

describe('startCommandServer', () => {
  test('runs the argv from the app directory with {port} replaced, as its own process group writing files off Windows', async () => {
    const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    const spawnFn = (cmd: string, args: string[], opts: SpawnOptions) => {
      calls.push({ cmd, args, opts });
      return makeChildProcess({ pid: 4242 });
    };
    const logsDir = join(root, 'logs');
    mkdirSync(logsDir);
    const output = openChildOutput(logsDir);
    try {
      await startCommandServer({
        root,
        port: 8095,
        logsDir,
        command,
        spawnFn,
        platform: 'darwin',
        output,
        baseEnv: { PATH: process.env.PATH, APP_ENV: 'staging' },
      });
      await startCommandServer({ root, port: 8095, logsDir, command, spawnFn, platform: 'win32', output });
    } finally {
      for (const fd of output.fds) closeSync(fd);
    }

    expect(calls[0]?.cmd).toBe('node');
    expect(calls[0]?.args).toEqual(['../react-native/cli.js', 'start', '--port', '8095']);
    expect(calls[0]?.opts).toMatchObject({
      cwd: root,
      detached: true,
      stdio: ['ignore', ...output.fds],
      env: { APP_ENV: 'staging' },
    });
    expect(calls[1]?.opts.detached).toBe(false);
  });

  test('what it writes to its output files becomes raw command records with inferred levels and bundle markers', async () => {
    const child = makeChildProcess({ pid: 4242 });
    const logsDir = join(root, 'logs');
    mkdirSync(logsDir);
    const output = openChildOutput(logsDir);
    for (const fd of output.fds) closeSync(fd);
    await startCommandServer({ root, port: 8096, logsDir, command, spawnFn: () => child, output });
    appendFileSync(output.files.stdout, 'iOS Bundled 812ms js/RNTesterApp.ios.js (1204 modules)\n');
    appendFileSync(output.files.stderr, 'error: Unable to resolve module ./Missing\n');

    const records = () =>
      parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8')).filter(
        (r) => !String(r.event).startsWith('cache_store_'),
      );
    await vi.waitFor(() =>
      expect(records()).toMatchObject([
        { src: 'metro', level: 'info', raw: true, event: 'command_stdout', marker: true },
        { src: 'metro', level: 'error', raw: true, event: 'command_stderr' },
      ]),
    );
    child.emit('exit', 0, null);
  });

  test('close refuses unconfirmed shutdown after signalling the group with SIGTERM and SIGKILL', async () => {
    vi.spyOn(identity, 'captureProcessToken').mockReturnValue('fixture-token');
    vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValue('same');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
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
      groupAlive: () => true,
      signalTree: (pid, sig, opts) => {
        signals.push([pid, sig as NodeJS.Signals, opts]);
        return true;
      },
    });
    await expect(server.close()).rejects.toThrow(/4242/);

    expect(signals).toEqual([
      [4242, 'SIGTERM', { group: true, platform: 'darwin' }],
      [4242, 'SIGKILL', { group: true, platform: 'darwin' }],
    ]);
  });

  describe.skipIf(process.platform === 'win32')('owned POSIX process', () => {
    test.each(['signal refused', 'exit unconfirmed'])(
      'close keeps a real child visible after %s and permits a later successful retry',
      async (failure) => {
        const child = getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const pid = child.pid;
        assert(pid);
        let retry = false;
        try {
          const server = await startCommandServer({
            root,
            port: 8099,
            logsDir: join(root, 'logs'),
            command,
            spawnFn: () => child,
            killTimeoutMs: 25,
            groupAlive: () => processGroupAlive(pid),
            signalTree: (_pid, signal) => (retry ? child.kill(signal) : failure !== 'signal refused'),
          });
          await expect(server.close()).rejects.toThrow(new RegExp(String(child.pid)));
          expect(child.exitCode === null && child.signalCode === null).toBe(true);
          retry = true;
          await expect(server.close()).resolves.toBeUndefined();
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
          }
        }
      },
    );
  });

  test('close refuses to signal a group after the wrapper identity is gone', async () => {
    vi.spyOn(identity, 'captureProcessToken').mockReturnValue('fixture-token');
    vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValue('gone');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const child = makeChildProcess({ pid: 4242 });
    let groupRunning = true;
    const signals: NodeJS.Signals[] = [];
    const server = await startCommandServer({
      root,
      port: 8098,
      logsDir: join(root, 'logs'),
      command,
      spawnFn: () => child,
      platform: 'darwin',
      killTimeoutMs: 1000,
      groupAlive: () => groupRunning,
      signalTree: (_pid, sig) => {
        signals.push(sig as NodeJS.Signals);
        groupRunning = false;
        return true;
      },
    });
    child.emit('exit', 0, null);
    await expect(server.close()).rejects.toThrow('Could not verify the dev-server process group');

    expect(signals).toEqual([]);
  });

  test('close checks identity again before escalating to SIGKILL', async () => {
    vi.spyOn(identity, 'captureProcessToken').mockReturnValue('fixture-token');
    vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValueOnce('same').mockReturnValue('different');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const signals: NodeJS.Signals[] = [];
    const server = await startCommandServer({
      root,
      port: 8098,
      logsDir: join(root, 'logs'),
      command,
      spawnFn: () => makeChildProcess({ pid: 4242 }),
      platform: 'darwin',
      killTimeoutMs: 1,
      groupAlive: () => true,
      signalTree: (_pid, sig) => {
        if (sig) signals.push(sig);
        return true;
      },
    });
    await expect(server.close()).rejects.toThrow('Could not verify the dev-server process group');
    expect(signals).toEqual(['SIGTERM']);
  });
});
