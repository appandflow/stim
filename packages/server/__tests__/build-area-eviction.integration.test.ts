import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { BuildArtifactCache } from 'stim/build-artifact-cache';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { BuildHost, type BuildHostOptions, type BuildLimits } from '../src/build.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 24 * 60 * 60_000;
const realStatfs = fs.statfsSync;
const socket = { readyState: WebSocket.OPEN, OPEN: WebSocket.OPEN, send: () => {}, bufferedAmount: 0 };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let home: string;
let root: string;
let running: BuildHost | null = null;
let logs: string[];

const start = (limits: Partial<BuildLimits> = {}, options: Partial<BuildHostOptions> = {}) => {
  running = new BuildHost({
    worker: join(home, 'worker.mjs'),
    env: process.env,
    limits: { daemonSweepMs: 60 * 60_000, ...limits },
    ...options,
  });
  return running;
};
const areaPath = (client: string, repo: string) => join(root, client, 'repos', repo);

function area(client: string, repo: string, daysAgo: number | null): string {
  const path = areaPath(client, repo);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'file'), repo);
  if (daysAgo !== null) writeFileSync(join(path, 'last-used'), String(Date.now() - daysAgo * DAY));
  return path;
}

function config(server: Record<string, unknown>): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 1000, ...server } }));
}

function freeGb(free: () => number): void {
  vi.spyOn(fs, 'statfsSync').mockImplementation((path) => ({
    ...realStatfs(path),
    bavail: free() * 1024 ** 3,
    bsize: 1,
  }));
  syncBuiltinESMExports();
}

function gateRemovalOf(matches: (path: string) => boolean) {
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const remove = fsPromises.rm;
  vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (typeof path === 'string' && matches(path)) {
      entered();
      await blocked;
    }
    return remove(path, options);
  });
  syncBuiltinESMExports();
  return { reached, release };
}

function launch(host: BuildHost, client: string, repo: string, gate?: string) {
  writeFileSync(
    join(home, 'worker.mjs'),
    `import { existsSync } from 'node:fs';
for await (const chunk of process.stdin) {}
while (${gate ? `!existsSync(${JSON.stringify(gate)})` : 'false'}) await new Promise(resolve => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: 'result', ok: false, code: 'fixture', message: 'fixture' }));`,
  );
  return host.launch({
    client,
    repo,
    job: { platform: 'ios' },
    session: host.session(client, socket, () => {}),
    send() {},
  });
}

const removed = () => logs.flatMap((line) => (/removed the build area (\S+?):/.exec(line) ?? []).slice(1));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-area-eviction-'));
  process.env.STIM_HOME = home;
  root = join(home, 'build-worker');
  mkdirSync(root, { recursive: true });
  config({});
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void logs.push(String(line)));
  freeGb(() => 1000);
});

afterEach(async () => {
  await running?.close();
  running = null;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('under low space it removes least recently used areas across clients until the margin is back', async () => {
  area('a', 'zeta', 40);
  area('a', 'alpha', 20);
  area('a', 'beta', 1);
  area('b', 'kappa', 30);
  area('b', 'omega', 2);
  config({ workerAreaMaxAgeDays: 0 });
  const left = () => readdirSync(join(root, 'a', 'repos')).length + readdirSync(join(root, 'b', 'repos')).length;
  freeGb(() => 20 + 15 * (5 - left()));
  await start({ minFreeBytes: 10 * 1024 ** 3, evictionMarginBytes: 40 * 1024 ** 3 }).evictAreas();

  expect(removed()).toEqual(['a/zeta', 'b/kappa']);
  expect(existsSync(areaPath('a', 'alpha'))).toBe(true);
  expect(readdirSync(join(root, 'a'))).not.toContain('zeta');
  expect(existsSync(`${areaPath('a', 'zeta')}.claims`)).toBe(false);
  expect(logs.join('\n')).toMatch(/near its disk floor/);
});

test.each([
  { name: 'the default', setting: undefined, gone: true },
  { name: 'a longer age', setting: 30, gone: false },
  { name: 'age turned off', setting: 0, gone: false },
])('removes an area unused for 8 days with room to spare under $name', async ({ setting, gone }) => {
  const old = area('a', 'old', 8);
  const recent = area('a', 'recent', 6);
  const newest = area('a', 'newest', 1);
  config(setting === undefined ? {} : { workerAreaMaxAgeDays: setting });
  await start().evictAreas();

  expect(existsSync(old)).toBe(!gone);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(newest)).toBe(true);
  expect(logs.filter((line) => /removed the build area a\/old: unused for 8\.0 days/.test(line))).toHaveLength(
    gone ? 1 : 0,
  );
});

test("keeps each client's newest area however old and however low the disk", async () => {
  const only = area('a', 'only', 100);
  const older = area('b', 'older', 60);
  const newest = area('b', 'newest', 50);
  freeGb(() => 11);
  await start().evictAreas();

  expect(existsSync(only)).toBe(true);
  expect(existsSync(newest)).toBe(true);
  expect(existsSync(older)).toBe(false);
});

test.each([
  {
    name: 'a recent record over old folder dates',
    prepare: (path: string) => {
      writeFileSync(join(path, 'last-used'), String(Date.now() - DAY));
      utimesSync(path, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    },
    kept: true,
  },
  {
    name: 'an old record over a changed folder',
    prepare: (path: string) => {
      writeFileSync(join(path, 'last-used'), String(Date.now() - 30 * DAY));
    },
    kept: false,
  },
  {
    name: 'a legacy area whose last build touched out',
    prepare: (path: string) => {
      mkdirSync(join(path, 'out'));
      utimesSync(path, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    },
    kept: true,
  },
  {
    name: 'a legacy area with nothing recent',
    prepare: (path: string) => {
      writeFileSync(join(path, 'mirror.json'), '{}');
      utimesSync(join(path, 'mirror.json'), new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
      utimesSync(path, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    },
    kept: false,
  },
])('judges last use from $name', async ({ prepare, kept }) => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', null);
  prepare(path);
  await start().evictAreas();
  expect(existsSync(path)).toBe(kept);
});

test('a build records its use, so it is what a later pass goes by', async () => {
  area('a', 'newest', 1);
  const path = area('a', 'subject', 30);
  const host = start();
  const job = launch(host, 'a', 'subject');
  assert(!('error' in job));
  await job.done;
  host.forget(job);
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(existsSync(areaPath('a', 'newest'))).toBe(true);
});

test('retains an area whose claim is held and removes it once released, naming why once', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const claim = tryAcquireClaim({ root: `${path}.claims`, mode: 'exclusive' }).acquired;
  assert(claim);
  const host = start();
  await host.evictAreas();
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.filter((line) => /retaining the build area a\/subject: its claim .* is held/.test(line))).toHaveLength(1);

  releaseClaim(claim);
  await host.evictAreas();
  expect(existsSync(path)).toBe(false);
});

test('retains an area whose claim a crashed Android build left unresolved', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const core = pathToFileURL(join(import.meta.dirname, '../../core/ownership-claim.ts')).href;
  const crash = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { markClaimChildPending, tryAcquireClaim } from ${JSON.stringify(core)};
markClaimChildPending(tryAcquireClaim({ root: ${JSON.stringify(`${path}.claims`)}, mode: 'exclusive' }).acquired);`,
    ],
    { encoding: 'utf8' },
  );
  expect(crash.stderr).toBe('');
  await start().evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/retaining the build area a\/subject: its claim is unresolved/);
});

test(
  'retains an area with a running Gradle daemon and removes it after the daemon exits',
  { skip: process.platform === 'win32' },
  async () => {
    area('a', 'newest', 0);
    const path = area('a', 'subject', 30);
    const daemon = spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write("ready"); setInterval(() => {}, 1000)',
        join(path, 'cache', 'gradle', 'wrapper', 'daemon.jar'),
        'org.gradle.launcher.daemon.bootstrap.GradleDaemon',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const closed = once(daemon, 'close');
    try {
      await once(daemon.stdout, 'data');
      const host = start();
      await host.evictAreas();
      expect(existsSync(path)).toBe(true);
      expect(logs.join('\n')).toMatch(/retaining the build area a\/subject: a Gradle daemon is running in it/);

      daemon.kill();
      await closed;
      await host.evictAreas();
      expect(existsSync(path)).toBe(false);
    } finally {
      daemon.kill();
    }
  },
);

test('retains an area whose Gradle daemon log names a live process the process list does not show', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  mkdirSync(join(path, 'cache', 'gradle', 'daemon', '8.14'), { recursive: true });
  writeFileSync(join(path, 'cache', 'gradle', 'daemon', '8.14', `daemon-${process.pid}.out.log`), '');
  await start().evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/may still use/);
});

test('a build refused while an eviction holds the claim creates nothing in the area', () => {
  const path = areaPath('a', 'subject');
  const claim = tryAcquireClaim({ root: `${path}.claims`, mode: 'exclusive' }).acquired;
  assert(claim);
  const refused = launch(start(), 'a', 'subject');
  expect(refused).toHaveProperty('error.code', 'build-busy');
  expect(existsSync(path)).toBe(false);
  releaseClaim(claim);
});

test('a build that starts while a pass lists processes keeps its area', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const gate = join(home, 'gate');
  const host = start();
  const pass = host.evictAreas();
  const job = launch(host, 'a', 'subject', gate);
  assert(!('error' in job));
  await pass;
  expect(existsSync(join(path, 'src', 'file'))).toBe(true);
  expect(logs.join('\n')).toMatch(/retaining the build area a\/subject: a build is running in it/);
  writeFileSync(gate, '');
  await job.done;
});

test('a build that starts while an evicted area is being deleted gets a clean area the deletion leaves alone', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const evicted = join(root, 'a', 'evicted');
  const { reached, release } = gateRemovalOf((target) => target === path || dirname(target) === evicted);
  const host = start();
  const pass = host.evictAreas();
  await reached;
  expect(existsSync(path)).toBe(false);

  const job = launch(host, 'a', 'subject');
  assert(!('error' in job));
  expect(existsSync(join(path, 'home'))).toBe(true);
  expect(existsSync(join(path, 'src'))).toBe(false);

  release();
  await Promise.all([pass, job.done]);
  expect(existsSync(join(path, 'home'))).toBe(true);
  expect(existsSync(evicted)).toBe(false);
  host.forget(job);
});

test('a pass deletes what an interrupted eviction left aside', async () => {
  area('a', 'newest', 0);
  mkdirSync(join(root, 'a', 'evicted', 'subject-interrupted'), { recursive: true });
  await start().evictAreas();
  expect(existsSync(join(root, 'a', 'evicted'))).toBe(false);
});

test('keeps an area through an unfetched build and a hosted handoff, removing it after the bundle is released', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 0);
  const host = start();
  const job = launch(host, 'a', 'subject');
  assert(!('error' in job));
  await job.done;
  const age = () => writeFileSync(join(path, 'last-used'), String(Date.now() - 30 * DAY));
  writeFileSync(join(areaPath('a', 'newest'), 'last-used'), String(Date.now()));

  age();
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/a finished build in it waits to be fetched/);

  const token = host.retain(job, { name: 'App.app', size: 1, sha256: sha('x') });
  assert(token);
  host.forget(job);
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/it holds a bundle for a hosted session/);

  const taken = host.takeBundle(token, sha('x'), () => true);
  assert(typeof taken !== 'string');
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);

  taken.release();
  await host.evictAreas();
  expect(existsSync(path)).toBe(false);
});

test('keeps an area an open connection is sending a manifest for until the connection closes', async () => {
  area('a', 'newest', 0);
  const synced = area('a', 'synced', 30);
  const host = start();
  const session = host.session('a', socket, () => {});
  session.sync({ repo: 'synced', files: [], done: false });
  await host.evictAreas();
  expect(existsSync(synced)).toBe(true);

  session.close(false);
  await host.evictAreas();
  expect(existsSync(synced)).toBe(false);
});

const IDENTITY = { fingerprint: 'fingerprint', cacheKey: 'key' };

test.each([
  {
    name: 'an offer',
    read: (host: BuildHost) => host.offer('a', { repo: 'subject', native: 'xcode', artifact: IDENTITY }),
  },
  {
    name: 'a cached artifact fetch',
    read: (host: BuildHost) =>
      host.session('a', socket, () => {}).cachedArtifact({ repo: 'subject', artifact: IDENTITY }),
  },
])('keeps an area while $name reads its artifact cache', async ({ read }) => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  let finish: (value: null) => void = () => {};
  let entered: () => void = () => {};
  const reached = new Promise<void>((resolve) => (entered = resolve));
  vi.spyOn(BuildArtifactCache.prototype, 'lookup')
    .mockResolvedValue(null)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        }),
    );
  const host = start();
  const reading = read(host);
  await reached;
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/its artifacts are being read/);

  finish(null);
  await reading;
  await host.evictAreas();
  expect(existsSync(path)).toBe(false);
});

test('serving a cached artifact counts as use', async () => {
  area('a', 'newest', 1);
  const path = area('a', 'subject', 30);
  const archive = join(home, 'artifact');
  writeFileSync(archive, 'x');
  const artifact = { ...IDENTITY, name: 'App.app', size: 1, sha256: sha('x') };
  vi.spyOn(BuildArtifactCache.prototype, 'lookup').mockResolvedValue(null);
  vi.spyOn(BuildArtifactCache.prototype, 'fetch').mockResolvedValue({ path: archive, artifact });
  const host = start();
  const served = await host.session('a', socket, () => {}).cachedArtifact({ repo: 'subject', artifact: IDENTITY });
  expect(served).toHaveProperty('result', artifact);
  await host.evictAreas();
  expect(existsSync(path)).toBe(true);
});

test('never touches an unapproved client, a stray folder or a symlinked client', async () => {
  const revoked = area('revoked', 'subject', 30);
  area('revoked', 'newer', 1);
  const outside = join(home, 'outside');
  mkdirSync(join(outside, 'repos', 'subject'), { recursive: true });
  mkdirSync(join(outside, 'repos', 'newer'), { recursive: true });
  writeFileSync(join(outside, 'repos', 'subject', 'last-used'), String(Date.now() - 30 * DAY));
  symlinkSync(outside, join(root, 'linked'));
  await start({}, { allowed: (client) => client !== 'revoked' }).evictAreas();

  expect(existsSync(revoked)).toBe(true);
  expect(existsSync(join(outside, 'repos', 'subject'))).toBe(true);
});

test("prunes the removed area's blobs and keeps those of a kept area", async () => {
  const blob = (text: string) => join(root, 'a', 'blobs', sha(text).slice(0, 2), sha(text));
  for (const text of ['only-evicted', 'kept']) {
    mkdirSync(dirname(blob(text)), { recursive: true });
    writeFileSync(blob(text), text);
  }
  const mirror = (text: string) => JSON.stringify({ a: { sha256: sha(text), kind: 'file', mtimeMs: 0, size: 1 } });
  writeFileSync(join(area('a', 'subject', 30), 'mirror.json'), mirror('only-evicted'));
  writeFileSync(join(area('a', 'newest', 0), 'mirror.json'), mirror('kept'));
  await start().evictAreas();

  expect(existsSync(blob('only-evicted'))).toBe(false);
  expect(existsSync(blob('kept'))).toBe(true);
});

test('a build near the floor starts a pass and is admitted without waiting for its deletion', async () => {
  area('a', 'stale', 30);
  area('a', 'newest', 1);
  config({ workerAreaMaxAgeDays: 0 });
  freeGb(() => 20);
  const evicted = join(root, 'a', 'evicted');
  const { reached, release } = gateRemovalOf((target) => dirname(target) === evicted);
  const host = start();
  const job = launch(host, 'a', 'current');
  assert(!('error' in job));
  await reached;
  expect(existsSync(areaPath('a', 'stale'))).toBe(false);
  release();
  await job.done;
  host.forget(job);
});

test(
  'the periodic check waits for a ready server, then removes stale areas and measures the root',
  { skip: process.platform === 'win32' },
  async () => {
    const stale = area('a', 'stale', 30);
    area('a', 'newest', 1);
    writeFileSync(join(stale, '..', 'newest', 'big'), Buffer.alloc(1024 * 1024));
    let ready = false;
    const host = start({ daemonSweepMs: 5, areaSweepMs: 5 }, { ready: () => ready });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(stale)).toBe(true);
    expect(host.workerRootUsage()).toBeNull();

    ready = true;
    await vi.waitFor(() => expect(existsSync(stale)).toBe(false));
    await vi.waitFor(() => expect(host.workerRootUsage()).not.toBeNull());
    expect(host.workerRootUsage()?.path).toBe(root);
    expect(host.workerRootUsage()?.bytes).toBeGreaterThanOrEqual(1024 * 1024);
  },
);

test('a restarted server reuses a recent measurement', { skip: process.platform === 'win32' }, async () => {
  area('a', 'only', 0);
  const measuredAt = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(join(root, 'usage.json'), JSON.stringify({ bytes: 42, measuredAt }));
  const host = start({ daemonSweepMs: 5, rootMeasureMs: 6 * 3_600_000 });
  await vi.waitFor(() => expect(host.workerRootUsage()).toEqual({ path: root, bytes: 42, measuredAt }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(host.workerRootUsage()?.bytes).toBe(42);
});

test(
  'a restarted server walks again after an old measurement and records it',
  { skip: process.platform === 'win32' },
  async () => {
    area('a', 'only', 0);
    const measuredAt = new Date(Date.now() - 7 * 3_600_000).toISOString();
    writeFileSync(join(root, 'usage.json'), JSON.stringify({ bytes: 42, measuredAt }));
    const host = start({ daemonSweepMs: 5, rootMeasureMs: 6 * 3_600_000 });
    await vi.waitFor(() => expect(host.workerRootUsage()?.bytes).not.toBe(42));
    expect(JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')).bytes).toBe(host.workerRootUsage()?.bytes);
  },
);
