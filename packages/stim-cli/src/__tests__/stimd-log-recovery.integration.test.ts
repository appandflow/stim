import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { parseNdjsonText } from '../ndjson.ts';
import { captureProcessToken } from '../process-identity.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { writeWebRecord } from '../web/state.ts';

const captured = vi.hoisted((): { workers: Worker[] } => ({ workers: [] }));
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

const spec: { platform: 'ios'; udid: string; bundleId: string; appName: string } = {
  platform: 'ios',
  udid: 'U1',
  bundleId: 'com.test.app',
  appName: 'Test',
};
const event = (at: number, msg: string) =>
  JSON.stringify({ eventType: 'logEvent', eventMessage: msg, timestamp: new Date(at).toISOString() });

describe.skipIf(process.platform === 'win32')('device log streams across a gap', () => {
  let home: string;
  let root: string;
  let env: Record<string, string>;
  let starts: string;
  let liveLine: string;
  let showLines: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-recovery-home-')));
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-recovery-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    starts = join(home, 'starts');
    liveLine = join(home, 'live-line');
    showLines = join(home, 'show-lines');
    writeFileSync(
      join(bin, 'xcrun'),
      `#!/bin/sh
case "$*" in
  *"log show"*) cat "${showLines}"; exit 0 ;;
  *"log stream"*) echo $$ >> "${starts}"; [ "$(wc -l < "${starts}")" -eq 1 ] && cat "${liveLine}"; exec sleep 600 ;;
esac
exit 1
`,
    );
    chmodSync(join(bin, 'xcrun'), 0o755);
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
    env = { STIM_HOME: home, PATH: process.env.PATH ?? '' };
    upsertProject(root, {});
  });

  afterEach(() => {
    for (const pid of existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean) : []) {
      try {
        process.kill(-Number(pid), 'SIGKILL');
      } catch {}
    }
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const records = () => {
    try {
      return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
    } catch {
      return [];
    }
  };
  const count = (msg: string) => records().filter((record) => record.msg === msg).length;
  const startCount = () => (existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0);

  test('a planned handover backfills the lines logged in the gap and repeats none already written', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const first = Date.now() - 5000;
    writeFileSync(liveLine, `${event(first, 'before')}\n`);
    writeFileSync(showLines, `${event(first, 'before')}\n${event(first + 1000, 'in the gap')}\n`);
    const predecessor = createStreams(() => {});
    const { streamId } = await predecessor.start({ root, ...spec }, env);
    await vi.waitFor(() => expect(count('before')).toBe(1));
    await predecessor.close({ handover: true });
    expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ handover: true, streamId });

    const successor = createStreams(() => {});
    try {
      successor.resume([root], env);
      await vi.waitFor(() => expect(count('in the gap')).toBe(1));
      await vi.waitFor(() => expect(startCount()).toBe(2));
      expect(count('before')).toBe(1);
      expect(records().some((record) => record.event === 'collector_interrupted')).toBe(false);
    } finally {
      await successor.close().catch(() => {});
    }
  }, 30_000);

  test('a logs worker failure restarts the streams with an interrupted record and backfills', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const first = Date.now() - 5000;
    writeFileSync(liveLine, `${event(first, 'before')}\n`);
    writeFileSync(showLines, `${event(first, 'before')}\n${event(first + 1000, 'lost with the worker')}\n`);
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start({ root, ...spec }, env);
      await vi.waitFor(() => expect(count('before')).toBe(1));
      const worker = captured.workers.at(-1);
      if (!worker) throw new Error('the logs worker was not started');
      await worker.terminate();
      await vi.waitFor(() => expect(startCount()).toBe(2));
      await vi.waitFor(() => expect(count('lost with the worker')).toBe(1));
      const interrupted = records().filter((record) => record.event === 'collector_interrupted');
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({ level: 'warn', streamId });
      expect(interrupted[0]?.msg).toContain('the logs worker failed');
      expect(count('before')).toBe(1);
      expect(streams.running()).toBe(true);
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ kind: 'stream', streamId });
    } finally {
      await streams.close().catch(() => {});
    }
  }, 30_000);

  test('a worker failure during a requested stop does not restart the stopped stream', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    writeFileSync(liveLine, `${event(Date.now() - 5000, 'before')}\n`);
    writeFileSync(showLines, '');
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start({ root, ...spec }, env);
      await vi.waitFor(() => expect(count('before')).toBe(1));
      const worker = captured.workers.at(-1);
      if (!worker) throw new Error('the logs worker was not started');
      const stopping = streams.stop(root, 'ios', 'default', streamId);
      await worker.terminate();
      expect(await stopping).toBe(true);
      await new Promise((done) => setTimeout(done, 800));
      expect(startCount()).toBe(1);
      expect(streams.running()).toBe(false);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    } finally {
      await streams.close().catch(() => {});
    }
  }, 30_000);

  test('a second worker failure does not restart a stream again and says logging stopped', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    writeFileSync(liveLine, `${event(Date.now() - 5000, 'before')}\n`);
    writeFileSync(showLines, '');
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start({ root, ...spec }, env);
      await vi.waitFor(() => expect(count('before')).toBe(1));
      await captured.workers.at(-1)?.terminate();
      await vi.waitFor(() => expect(startCount()).toBe(2));
      await vi.waitFor(() =>
        expect(records().filter((record) => record.event === 'collector_interrupted')).toHaveLength(1),
      );
      await vi.waitFor(() => expect(streams.running()).toBe(true));
      await captured.workers.at(-1)?.terminate();
      await vi.waitFor(() =>
        expect(records().filter((record) => record.event === 'collector_interrupted')).toHaveLength(2),
      );
      const last = records().filter((record) => record.event === 'collector_interrupted')[1];
      expect(last?.msg).toContain('logging stopped');
      expect(last?.msg).toContain('stim ios|android');
      await new Promise((done) => setTimeout(done, 800));
      expect(startCount()).toBe(2);
      expect(streams.running()).toBe(false);
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId, handover: true });
    } finally {
      await streams.close().catch(() => {});
    }
  }, 30_000);

  test('a worker failure no longer blocks draining a workspace once the new worker has synced it', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    if (child.pid === undefined) throw new Error('the browser did not start');
    const chrome = { pid: child.pid, processToken: captureProcessToken(child.pid) ?? '' };
    writeWebRecord(root, {
      ...chrome,
      chromeProcess: chrome,
      chrome: process.execPath,
      headless: true,
      viewport: 'desktop',
      ignoreCertificateErrors: false,
      cdpPort: 1,
      profile: join(root, 'profile'),
      url: 'http://localhost:1/',
      startedAt: new Date().toISOString(),
    });
    child.kill('SIGKILL');
    await once(child, 'exit');
    const streams = createStreams(() => {});
    try {
      expect(await streams.ownedSync(root)).toBeNull();
      const worker = captured.workers.at(-1);
      if (!worker) throw new Error('the logs worker was not started');
      await worker.terminate();
      await vi.waitFor(async () => {
        const answer = await streams.ownedDrain(root);
        expect(answer).not.toContain('previous owned log worker exited');
      });
      expect(await streams.ownedDrain(root)).toContain('unavailable');
      expect(streams.ownedRunning()).toBe(false);
    } finally {
      await streams.close().catch(() => {});
    }
  }, 30_000);
});
