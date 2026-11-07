import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

const fault = vi.hoisted(() => ({ fail: true }));
const captured = vi.hoisted(() => ({ workers: [] as Worker[] }));
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>();
  class CapturedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      captured.workers.push(this);
    }
  }
  return { ...actual, Worker: CapturedWorker };
});
vi.mock('../stimd/logs/state.ts', async (original) => {
  const actual = await original<typeof import('../stimd/logs/state.ts')>();
  return {
    ...actual,
    unregisterStreamAll: (...args: Parameters<typeof actual.unregisterStreamAll>) => {
      if (fault.fail) {
        fault.fail = false;
        throw new Error('state write failed');
      }
      return actual.unregisterStreamAll(...args);
    },
  };
});

describe.skipIf(process.platform === 'win32')('device stream cleanup', () => {
  test('a failed state write remains recoverable after the owner exits', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-log-cleanup-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-cleanup-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    writeFileSync(join(bin, 'xcrun'), '#!/bin/sh\nexec sleep 600\n');
    chmodSync(join(bin, 'xcrun'), 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const moduleUrl = new URL('../stimd/logs/streams.ts', import.meta.url).href;
    const script = join(home, 'owner.mjs');
    writeFileSync(
      script,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createStreams } from ${JSON.stringify(moduleUrl)};
const streams = createStreams(() => {});
const { streamId } = await streams.start({ root: ${JSON.stringify(root)}, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }, process.env);
const rename = fs.renameSync;
fs.renameSync = (...args) => { if (String(args[1]).endsWith('/state.json')) throw new Error('state write failed'); return rename(...args); };
syncBuiltinESMExports();
try { await streams.stop(${JSON.stringify(root)}, 'ios', 'default', streamId); } catch {}
console.log(streamId);
process.exit(0);
`,
    );
    const owner = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    owner.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    owner.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const streams = createStreams(() => {});
    fault.fail = false;
    try {
      const [code] = await once(owner, 'exit');
      expect({ code, errors }).toEqual({ code: 0, errors: '' });
      const streamId = output.trim();
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      fault.fail = true;
      await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('state write failed');
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    } finally {
      owner.kill('SIGTERM');
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('closing terminates the worker even when stream cleanup fails', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-log-cleanup-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-cleanup-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    fault.fail = true;
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const worker = captured.workers.at(-1);
      if (!worker) throw new Error('the logs worker was not started');
      await expect(streams.close()).rejects.toThrow('could not be stopped');
      expect(worker.threadId).toBe(-1);
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a later stop retries a failed state write while the claim remains', async () => {
    fault.fail = true;
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-log-cleanup-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-cleanup-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const messages: string[] = [];
    const streams = createStreams((message) => messages.push(message));
    try {
      const spec = { root, platform: 'ios' as const, udid: 'U1', bundleId: 'com.test.app', appName: 'Test' };
      const { streamId } = await streams.start(spec, env);
      await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('could not be stopped');
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      expect(messages.some((message) => message.includes('state write failed'))).toBe(true);
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      const next = await streams.start(spec, env);
      expect(await streams.stop(root, 'ios', 'default', next.streamId)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
