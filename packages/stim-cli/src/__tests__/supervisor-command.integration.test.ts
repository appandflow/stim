import assert from 'node:assert';
import { once } from 'node:events';
import { getExecutor } from '../exec.ts';
import { processGroupAlive } from '../ownership-claim.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNdjsonWriter, parseNdjsonText } from '../ndjson.ts';
import { commandServerLaunch } from '../stimd/metro/server-command.ts';
import { superviseChildServer } from '../stimd/metro/child-server.ts';
import { outputRecord } from '../stimd/metro/output-records.ts';
import { MODE_COMMAND } from '../stimd/metro/state.ts';
import { makeChildProcess } from './_factories.ts';
import * as identity from '../process-identity.ts';
import type { ChildProcess } from 'node:child_process';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-command-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const command = ['node', '../react-native/cli.js', 'start', '--port', '{port}'];

function supervise(
  child: ChildProcess,
  {
    killTimeoutMs = 1,
    groupAlive = () => true,
    signal = () => true,
  }: { killTimeoutMs?: number; groupAlive?: () => boolean; signal?: (sig: NodeJS.Signals) => boolean } = {},
) {
  const logsDir = join(root, 'logs');
  mkdirSync(logsDir, { recursive: true });
  return superviseChildServer({
    mode: MODE_COMMAND,
    child,
    log: createNdjsonWriter(join(logsDir, 'metro.ndjson')),
    toRecord: outputRecord(MODE_COMMAND),
    signal,
    alive: groupAlive,
    killTimeoutMs,
  });
}

test('metro.command runs its argv from the app directory with {port} replaced and the caller environment', () => {
  const launch = commandServerLaunch({
    root,
    port: 8095,
    logsDir: join(root, 'logs'),
    command,
    baseEnv: { PATH: process.env.PATH, APP_ENV: 'staging' },
  });
  expect(launch).toMatchObject({
    command: 'node',
    args: ['../react-native/cli.js', 'start', '--port', '8095'],
    env: { APP_ENV: 'staging' },
  });
});

describe('a supervised dev server', () => {
  test('what it writes to its pipes becomes raw command records with inferred levels and bundle markers', async () => {
    const child = makeChildProcess({ pid: 4242 });
    supervise(child);
    child.stdout?.emit('data', 'iOS Bundled 812ms js/RNTesterApp.ios.js (1204 modules)\n');
    child.stderr?.emit('data', 'error: Unable to resolve module ./Missing\n');

    const records = parseNdjsonText(readFileSync(join(root, 'logs', 'metro.ndjson'), 'utf-8'));
    expect(records).toMatchObject([
      { src: 'metro', level: 'info', raw: true, event: 'command_stdout', marker: true },
      { src: 'metro', level: 'error', raw: true, event: 'command_stderr' },
    ]);
  });

  test('a line written after the leader exits is recorded once the pipes close', () => {
    const child = makeChildProcess({ pid: 4242 });
    supervise(child);
    child.emit('exit', 0, null);
    child.stdout?.emit('data', 'written by a group member after the leader exited');
    child.emit('close', 0, null);

    const records = parseNdjsonText(readFileSync(join(root, 'logs', 'metro.ndjson'), 'utf-8'));
    expect(records).toMatchObject([{ msg: 'written by a group member after the leader exited' }]);
  });

  test('close refuses an unconfirmed shutdown after signalling the group with SIGTERM', async () => {
    vi.spyOn(identity, 'captureProcessToken').mockReturnValue('fixture-token');
    vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValue('same');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const signals: NodeJS.Signals[] = [];
    const server = supervise(makeChildProcess({ pid: 4242 }), {
      signal: (sig) => {
        signals.push(sig);
        return true;
      },
    });
    await expect(server.close()).rejects.toThrow(/4242/);
    expect(signals).toEqual(['SIGTERM']);
  });

  describe.skipIf(process.platform === 'win32')('owned POSIX process', () => {
    test.each(['signal refused', 'exit unconfirmed'])(
      'close kills a real leader by its own verified pid after the group signal had no effect (%s)',
      async (failure) => {
        const child = getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const pid = child.pid;
        assert(pid);
        try {
          const exited = once(child, 'exit');
          const server = supervise(child, {
            killTimeoutMs: 25,
            groupAlive: () => processGroupAlive(pid),
            signal: () => failure !== 'signal refused',
          });
          await expect(server.close()).resolves.toBeUndefined();
          await exited;
          expect(child.signalCode).toBe('SIGKILL');
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

  test('close refuses to signal a group after the leader identity is gone', async () => {
    vi.spyOn(identity, 'captureProcessToken').mockReturnValue('fixture-token');
    vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValue('gone');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const child = makeChildProcess({ pid: 4242 });
    const signals: NodeJS.Signals[] = [];
    const server = supervise(child, {
      killTimeoutMs: 1000,
      signal: (sig) => {
        signals.push(sig);
        return true;
      },
    });
    child.emit('exit', 0, null);
    await expect(server.close()).rejects.toThrow(/the leader had already exited/);
    expect(signals).toEqual([]);
  });

  test('close sends no group signal when the leader identity changed after it was first read', async () => {
    vi.spyOn(identity, 'captureProcessToken').mockReturnValue('fixture-token');
    vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValueOnce('same').mockReturnValue('different');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const signals: NodeJS.Signals[] = [];
    const server = supervise(makeChildProcess({ pid: 4242 }), {
      signal: (sig) => {
        signals.push(sig);
        return true;
      },
    });
    await expect(server.close()).rejects.toThrow(/process group 4242/);
    expect(signals).toEqual([]);
  });
});
