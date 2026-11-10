import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { BuildWorkerRoot, type BuildLimits } from '../src/build.ts';
import { BuildHost } from '../../stim-cli/src/job/offload/host.ts';
import { buildSlotPath, windowsShortDir, windowsShortDirKey } from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const file = (path: string, text: string, size = text.length) => ({ path, kind: 'file', size, sha256: sha(text) });
const frame = (digest: string, bytes: string) => Buffer.concat([Buffer.from(digest, 'hex'), Buffer.from(bytes)]);

const socket = { readyState: WebSocket.OPEN, OPEN: WebSocket.OPEN, send: () => {}, bufferedAmount: 0 };

let home: string;
let root: string;
let running: BuildHost | BuildWorkerRoot | null = null;
let live: { client: string; repo: string }[] = [];

const start = (limits: Partial<BuildLimits> = {}) => {
  const host = new BuildHost({ worker: 'unused', env: process.env, limits });
  running = host;
  return host;
};

const startRoot = () => {
  const workerRoot = new BuildWorkerRoot({ jobs: () => live, stopJobs: async () => {} });
  running = workerRoot;
  return workerRoot;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-limits-'));
  process.env.STIM_HOME = home;
  root = join(home, 'build-worker');
  mkdirSync(root, { recursive: true });
});

afterEach(async () => {
  await running?.close();
  running = null;
  live = [];
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test.each(['foreign-owner', 'parent-child'] as const)(
  '%s repository Gradle cleanup retains unresolved claims only',
  { skip: process.platform !== 'win32' },
  async (scenario) => {
    vi.stubEnv('SystemDrive', home);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ concurrency: { maxBuilds: 1 } }));
    const client = 'collision-client';
    const repo = 'app-1';
    const area = join(root, client, 'repos', repo);
    const gradle = windowsShortDir(join(area, 'cache', 'gradle'));
    mkdirSync(gradle, { recursive: true });
    writeFileSync(
      `${gradle}.owner`,
      scenario === 'foreign-owner' ? 'another-repository' : windowsShortDirKey('gradle', area),
    );
    const gate = join(home, 'worker-gate');
    const worker = join(home, 'worker.mjs');
    writeFileSync(
      worker,
      `import { existsSync } from 'node:fs';
for await (const chunk of process.stdin) {}
while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: 'result', ok: false, code: 'worker-crashed', message: 'private fixture failed' }));`,
    );
    const daemon = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)', process.argv[1], 'KotlinCompileDaemon'], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => process.stdout.write(JSON.stringify({ child: child.pid })));
setInterval(() => {}, 1000);`.replaceAll('\n', ' '),
        join(gradle, 'wrapper', 'gradle-daemon-main.jar'),
        'org.gradle.launcher.daemon.bootstrap.GradleDaemon',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const daemonClosed = once(daemon, 'close');
    let childPid: number | null = null;
    try {
      assert(daemon.stdout);
      const [ready] = await once(daemon.stdout, 'data');
      const value = JSON.parse(String(ready));
      assert.equal(typeof value.child, 'number');
      childPid = value.child;
      running = new BuildHost({
        worker,
        env: process.env,
        limits: { minFreeBytes: 0, minFreeMemoryBytes: 0, killGraceMs: 100 },
      });
      const launched = await running.launch({
        client,
        repo,
        job: { platform: 'android' },
        session: running.session(client, socket, () => {}),
        send() {},
      });
      assert(!('error' in launched));
      expect(readClaimSet(buildSlotPath(0)).live).toHaveLength(1);
      writeFileSync(gate, '');
      await launched.done;
      const unresolved = scenario === 'foreign-owner';
      if (!unresolved) await daemonClosed;
      expect(launched.outcome).toHaveProperty('code', unresolved ? 'cleanup-unresolved' : 'worker-crashed');
      expect(daemon.exitCode === null && daemon.signalCode === null).toBe(unresolved);
      expect(readClaimSet(`${area}.claims`).live).toHaveLength(unresolved ? 1 : 0);
      expect(readClaimSet(buildSlotPath(0)).live).toHaveLength(unresolved ? 1 : 0);
      if (!unresolved) assert.throws(() => process.kill(value.child, 0), { code: 'ESRCH' });
    } finally {
      if (childPid) {
        try {
          process.kill(childPid);
        } catch {}
      }
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill();
        await daemonClosed;
      }
      vi.unstubAllEnvs();
    }
  },
);

test('refuses a blob whose declared size would take the worker volume under its free floor', () => {
  const stats = statfsSync(root);
  const free = stats.bavail * stats.bsize;
  const declared = 2 * 1024 ** 3;
  const session = start({ minFreeBytes: free - declared / 2 }).session('client', socket, () => {});
  expect(session.sync({ repo: 'app-1', files: [{ ...file('a', 'big'), size: declared }], done: true })).toHaveProperty(
    'result.missing',
    [sha('big')],
  );
  expect(session.blob(frame(sha('big'), 'b'))).toMatch(/declines the upload/);
  expect(existsSync(join(root, 'client', 'blobs'))).toBe(false);
});

test("shutdown awaits a revoked client's deletion, but not through a symlink or outside the worker root", async () => {
  const host = startRoot();
  mkdirSync(join(root, 'gone', 'repos', 'app-1', 'src'), { recursive: true });
  writeFileSync(join(root, 'gone', 'repos', 'app-1', 'src', 'a'), 'x');
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'x');
  symlinkSync(outside, join(root, 'linked'));

  await host.remove('linked');
  await host.remove('..');

  let entered: () => void = () => {};
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const remove = fsPromises.rm;
  const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (path === join(root, 'gone')) {
      entered();
      await blocked;
    }
    return remove(path, options);
  });
  syncBuiltinESMExports();
  const removal = host.remove('gone');
  let closing: Promise<boolean> | undefined;
  try {
    await ready;
    let closed = false;
    closing = host.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await Promise.all([removal, closing]);
  } finally {
    release();
    await Promise.allSettled([removal, closing]);
    deletion.mockRestore();
    syncBuiltinESMExports();
  }

  expect(existsSync(join(root, 'gone'))).toBe(false);
  expect(existsSync(join(outside, 'keep'))).toBe(true);
  expect(existsSync(root)).toBe(true);
});

test('prunes blobs no mirror references once no job of the client runs, and none while a mirror is unreadable', () => {
  const host = startRoot();
  const client = join(root, 'client');
  const blob = (text: string) => join(client, 'blobs', sha(text).slice(0, 2), sha(text));
  for (const text of ['mirrored', 'stale']) {
    mkdirSync(join(blob(text), '..'), { recursive: true });
    writeFileSync(blob(text), text);
  }
  const incoming = join(client, 'blobs', '.incoming-upload');
  writeFileSync(incoming, 'partial');
  mkdirSync(join(client, 'repos', 'app-1'), { recursive: true });
  writeFileSync(
    join(client, 'repos', 'app-1', 'mirror.json'),
    JSON.stringify({ a: { sha256: sha('mirrored'), kind: 'file', mtimeMs: 0, size: 8 } }),
  );
  live = [{ client: 'client', repo: 'app-2' }];
  host.pruneBlobs('client');
  expect(existsSync(blob('stale'))).toBe(true);
  live = [];

  mkdirSync(join(client, 'repos', 'app-3'));
  writeFileSync(join(client, 'repos', 'app-3', 'mirror.json'), '{');
  host.pruneBlobs('client');
  expect(existsSync(blob('stale'))).toBe(true);

  rmSync(join(client, 'repos', 'app-3'), { recursive: true });
  host.pruneBlobs('client');
  expect(existsSync(blob('stale'))).toBe(false);
  expect(existsSync(blob('mirrored'))).toBe(true);
  expect(existsSync(incoming)).toBe(true);
});

test('caps the declared bytes of one manifest across its pages', () => {
  const session = start({ maxManifestBytes: 10 }).session('client', socket, () => {});
  expect(session.sync({ repo: 'app-1', files: [file('a', 'aaaaaa')], done: true })).toHaveProperty('result');
  expect(session.sync({ repo: 'app-1', files: [file('a', 'aaaaaa')], done: false })).toHaveProperty('result');
  expect(session.sync({ repo: 'app-1', files: [file('b', 'bbbbbb')], done: true })).toHaveProperty(
    'error.code',
    'limit-exceeded',
  );
});

test('refuses a blob that streams more bytes than its manifest entry declares', () => {
  const session = start().session('client', socket, () => {});
  session.sync({ repo: 'app-1', files: [file('a', 'x')], done: true });
  expect(session.blob(frame(sha('x'), 'xx'))).toMatch(/larger than its manifest entry/);
  expect(existsSync(join(root, 'client', 'blobs', sha('x').slice(0, 2), sha('x')))).toBe(false);
});
