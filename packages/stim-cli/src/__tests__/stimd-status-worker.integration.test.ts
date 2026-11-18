import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ netThread: '' }));
vi.mock('../spawn-entry.ts', () => ({ spawnEntry: () => fixture.netThread }));

import { createNetThread, type NetOptions } from '../stimd/net.ts';

const REPOSITORIES = 40;
const STATUS_WORKER = join(import.meta.dirname, '..', 'status-worker.ts');
const STATUS_FEED = pathToFileURL(join(import.meta.dirname, '..', '..', '..', 'server', 'src', 'status-feed.ts')).href;

const options: NetOptions = {
  port: 0,
  extraEnv: [],
  pathPrepend: [],
  loopbackOnly: true,
  shareOnly: false,
  desktopKey: 'key',
  script: 'fixture',
};

let root: string;

/** Whether `pid` runs; a zombie does not, and the status worker reaps its children only once its loop is free. */
function running(pid: number): boolean {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-status-worker-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A net thread whose server is only the real status feed, wired to stimd the way `net-thread.ts` wires it: it listens
 * once the feed has a payload, so the status worker has opened its watches, and closes the feed when told to stop.
 */
function netThreadFixture(env: NodeJS.ProcessEnv): string {
  const file = join(root, 'net-thread.mjs');
  writeFileSync(
    file,
    `import { parentPort } from 'node:worker_threads';
const { StatusFeed } = await import(${JSON.stringify(STATUS_FEED)});
const feed = new StatusFeed({
  worker: ${JSON.stringify(STATUS_WORKER)},
  env: ${JSON.stringify(env)},
  cwd: ${JSON.stringify(root)},
  spawn: (request) => parentPort.postMessage({ type: 'statusWorker', request }, [request.port]),
});
let listening = false;
feed.subscribe({
  item: () => {
    if (!listening) parentPort.postMessage({ type: 'listening', port: 1 });
    listening = true;
  },
  failed: (message) => parentPort.postMessage({ type: 'refused', message, clean: true }),
});
parentPort.on('message', (message) => {
  if (message.type !== 'stop') return;
  void feed.close().then(() => {
    parentPort.postMessage({ type: 'closed' });
    parentPort.close();
  });
});
`,
  );
  return file;
}

it.skipIf(process.platform !== 'darwin')(
  'the net thread stops while its status worker still closes its FSEvents watches, and the worker exits after',
  async () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const projects: Record<string, object> = {};
    for (let i = 0; i < REPOSITORIES; i++) {
      const repo = join(root, 'repos', `r${i}`);
      mkdirSync(join(repo, '.git', 'refs'), { recursive: true });
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      projects[repo] = {};
    }
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projects }));
    const sdk = join(root, 'sdk');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    const adbPid = join(root, 'adb.pid');
    writeFileSync(
      join(sdk, 'platform-tools', 'adb'),
      `#!/bin/sh\nif [ "$1" = track-devices ]; then echo $$ > '${adbPid}'; exec /bin/sleep 600; fi\n`,
    );
    chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
    fixture.netThread = netThreadFixture({
      STIM_HOME: home,
      HOME: root,
      ANDROID_HOME: sdk,
      PATH: process.env.PATH,
    });

    const workers: Worker[] = [];
    const created = (worker: Worker) => workers.push(worker);
    process.on('worker', created);
    const onExit = vi.fn<(failure?: Error) => void>();
    const net = createNetThread(() => {}, onExit);
    try {
      expect(await net.ensure(options)).toEqual({ listening: true, port: 1, loopbackOnly: true });
      const [, status] = workers;
      let statusExited = false;
      const statusExit = new Promise<number>((resolve) =>
        status?.once('exit', (code) => {
          statusExited = true;
          resolve(code);
        }),
      );
      await vi.waitUntil(() => existsSync(adbPid) && readFileSync(adbPid, 'utf8').endsWith('\n'), { timeout: 30_000 });
      const tracker = Number(readFileSync(adbPid, 'utf8'));

      await net.close();

      expect(onExit).toHaveBeenCalledWith();
      expect(status).toBeDefined();
      expect(statusExited).toBe(false);
      await vi.waitUntil(() => !running(tracker), { timeout: 10_000 });
      expect(await statusExit).toBe(0);
    } finally {
      process.off('worker', created);
      await net.close().catch(() => {});
      const tracker = existsSync(adbPid) ? Number(readFileSync(adbPid, 'utf8')) : 0;
      if (tracker > 0 && running(tracker)) process.kill(tracker);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
  300_000,
);
