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
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { BuildArtifactCache } from '../../stim-cli/src/offload/build-artifact-cache.ts';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { tryAcquireBuildSlotClaim, windowsShortDir, windowsShortDirKey } from '@stim-cli/core/state';
import { BuildWorkerRoot, type BuildLimits } from '../src/build.ts';
import { BuildHost, type BuildHostOptions } from '../../stim-cli/src/job/offload/host.ts';
import { areaLastUsed, recordAreaUse, recordRootUsage } from '../src/worker-areas.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const processList = vi.hoisted((): { requested: (() => void) | null } => ({ requested: null }));
vi.mock('../src/processes.ts', async (original) => {
  const real = await original<typeof import('../src/processes.ts')>();
  return {
    ...real,
    listCommandLines: () => {
      processList.requested?.();
      return real.listCommandLines();
    },
  };
});

const DAY = 24 * 60 * 60_000;
const realStatfs = fs.statfsSync;
const IDENTITY = { fingerprint: 'fingerprint', cacheKey: 'key' };
const socket = { readyState: WebSocket.OPEN, OPEN: WebSocket.OPEN, send: () => {}, bufferedAmount: 0 };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let home: string;
let root: string;
let running: Worker | null = null;
let logs: string[];

/** stimd's worker root with one offload job's host, whose launched builds and connections count as live jobs. */
class Worker {
  readonly root: BuildWorkerRoot;
  readonly host: BuildHost;
  private readonly live = new Map<object, { client: string; repo: string }>();

  constructor(
    limits: Partial<BuildLimits>,
    options: Partial<BuildHostOptions> & { allowed?: (client: string) => boolean; ready?: () => boolean },
  ) {
    this.host = new BuildHost({ worker: join(home, 'worker.mjs'), env: process.env, limits, ...options });
    this.root = new BuildWorkerRoot({
      limits,
      allowed: options.allowed,
      ready: options.ready,
      jobs: () => this.live.values(),
      stopJobs: async (client) => {
        for (const [entry, owner] of this.live) {
          if (owner.client !== client) continue;
          this.live.delete(entry);
          const job = entry as Partial<{ cancel: () => void; done: Promise<void> }>;
          job.cancel?.();
          await job.done;
        }
      },
    });
  }

  launch(args: Parameters<BuildHost['launch']>[0]) {
    this.root.maintainAreas();
    const job = this.host.launch(args);
    if (!('error' in job)) this.live.set(job, { client: args.client, repo: args.repo });
    return job;
  }

  /** An offload job of `client` for `repo`, live until the returned function ends it. */
  connect(client: string, repo: string): () => void {
    const entry = {};
    this.live.set(entry, { client, repo });
    return () => this.live.delete(entry);
  }

  forget(job: object & { id: string }) {
    this.host.forget(job as never);
    this.live.delete(job);
  }

  session(...args: Parameters<BuildHost['session']>) {
    return this.host.session(...args);
  }

  offer(...args: Parameters<BuildHost['offer']>) {
    return this.host.offer(...args);
  }

  retain(...args: Parameters<BuildHost['retain']>) {
    return this.host.retain(...args);
  }

  takeBundle(...args: Parameters<BuildWorkerRoot['takeBundle']>) {
    return this.root.takeBundle(...args);
  }

  evictAreas() {
    return this.root.evictAreas();
  }

  remove(client: string) {
    return this.root.remove(client);
  }

  workerRootUsage() {
    return this.root.workerRootUsage();
  }

  async close() {
    await this.host.close();
    await this.root.close();
  }
}

const start = (
  limits: Partial<BuildLimits> = {},
  options: Partial<BuildHostOptions> & { allowed?: (client: string) => boolean; ready?: () => boolean } = {},
) => {
  running = new Worker({ daemonSweepMs: 60 * 60_000, ...limits }, options);
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

function launch(host: Worker, client: string, repo: string, gate?: string) {
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
  await running?.evictAreas();
  running = null;
  processList.requested = null;
  vi.unstubAllEnvs();
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

test('low space spares an area used in the last 3 hours, saying so once while it lasts', async () => {
  config({ workerAreaMaxAgeDays: 0 });
  area('a', 'newest', 0.01);
  const recent = area('a', 'recent', 0.1);
  freeGb(() => 40);
  const host = start();
  await host.evictAreas();
  await host.evictAreas();
  expect(existsSync(recent)).toBe(true);
  expect(logs.filter((line) => /stays under 50\.0 GB free/.test(line))).toHaveLength(1);
});

test('under the floor recent areas go too, until the floor is cleared, but never a newest', async () => {
  config({ workerAreaMaxAgeDays: 0 });
  area('a', 'newest', 0.01);
  const newer = area('a', 'newer', 0.02);
  const older = area('a', 'older', 0.03);
  freeGb(() => 5 + 10 * (3 - readdirSync(join(root, 'a', 'repos')).length));
  await start().evictAreas();
  expect(existsSync(older)).toBe(false);
  expect(existsSync(newer)).toBe(true);
  expect(existsSync(areaPath('a', 'newest'))).toBe(true);
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

test('a last-used dated in the future counts for nothing', async () => {
  area('a', 'newest', 1);
  const path = area('a', 'subject', -365);
  fs.utimesSync(path, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
  await start().evictAreas();
  expect(existsSync(path)).toBe(false);
  expect(existsSync(areaPath('a', 'newest'))).toBe(true);
});

test('a file date in the future counts for nothing, and with no other date the area counts as used now', () => {
  const path = area('a', 'subject', null);
  const future = new Date(Date.now() + 365 * DAY);
  const old = new Date(Date.now() - 30 * DAY);
  writeFileSync(join(path, 'mirror.json'), '{}');
  utimesSync(join(path, 'mirror.json'), future, future);
  utimesSync(path, old, old);
  expect(Math.abs(areaLastUsed(path) - old.getTime())).toBeLessThan(1000);

  utimesSync(path, future, future);
  const before = Date.now();
  expect(areaLastUsed(path)).toBeGreaterThanOrEqual(before);
  expect(areaLastUsed(path)).toBeLessThan(future.getTime());
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

test('an eviction pass reuses the process list across refusals and refreshes it after deletion', async () => {
  area('a', 'newest', 0);
  const removedPath = area('a', 'expired', 30);
  const held = [area('a', 'older-claim', 40), area('a', 'old-claim', 35), area('a', 'later-claim', 25)];
  for (const path of held) {
    const claim = tryAcquireClaim({ root: `${path}.claims`, mode: 'exclusive' }).acquired;
    assert(claim);
    onTestFinished(() => void releaseClaim(claim));
  }
  let listings = 0;
  processList.requested = () => listings++;

  await start().evictAreas();

  expect(listings).toBe(2);
  expect(existsSync(removedPath)).toBe(false);
  expect(held.every(existsSync)).toBe(true);
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
  vi.stubEnv('SystemDrive', home);
  const gradleHome =
    process.platform === 'win32' ? windowsShortDir(win32.join(path, 'cache', 'gradle')) : join(path, 'cache', 'gradle');
  mkdirSync(join(gradleHome, 'daemon', '8.14'), { recursive: true });
  writeFileSync(join(gradleHome, 'daemon', '8.14', `daemon-${process.pid}.out.log`), '');
  await start().evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/may still use/);
});

test('a build refused for a build slot leaves no area and records no use', () => {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ server: { maxLoadPerCore: 1000 }, concurrency: { maxBuilds: 1 } }),
  );
  const slot = tryAcquireBuildSlotClaim({ max: 1, details: {} });
  assert(slot);
  const old = area('a', 'old', 30);
  const recorded = readFileSync(join(old, 'last-used'), 'utf8');
  const host = start();
  expect(launch(host, 'a', 'fresh')).toHaveProperty('error.code', 'build-busy');
  expect(launch(host, 'a', 'old')).toHaveProperty('error.code', 'build-busy');
  expect(existsSync(areaPath('a', 'fresh'))).toBe(false);
  expect(readFileSync(join(old, 'last-used'), 'utf8')).toBe(recorded);
  releaseClaim(slot.claim);
});

test('a cached artifact miss creates no area', async () => {
  const real = area('a', 'real', 1);
  freeGb(() => 40);
  const host = start();
  const session = host.session('a', socket, () => {});
  expect(await session.cachedArtifact({ repo: 'gone', artifact: IDENTITY })).toEqual({ result: null });
  session.close();
  expect(existsSync(areaPath('a', 'gone'))).toBe(false);
  await host.evictAreas();
  expect(existsSync(real)).toBe(true);
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
  let job: ReturnType<typeof launch> | undefined;
  processList.requested = () => {
    processList.requested = null;
    job = launch(host, 'a', 'subject', gate);
  };
  await host.evictAreas();
  expect(existsSync(join(path, 'src', 'file'))).toBe(true);
  writeFileSync(gate, '');
  assert(job && !('error' in job));
  await job.done;
});

test('a use recorded while a pass lists processes saves the area', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  processList.requested = () => writeFileSync(join(path, 'last-used'), String(Date.now()));
  await start().evictAreas();
  expect(existsSync(path)).toBe(true);
  expect(removed()).toEqual([]);
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

const failDeletionOf = (matches: (path: string) => boolean) => {
  const remove = fsPromises.rm;
  const spy = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (typeof path === 'string' && matches(path)) throw new Error('fixture: delete refused');
    return remove(path, options);
  });
  syncBuiltinESMExports();
  return () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
};

const evictedIn = (client: string) => join(root, client, 'evicted');
const leftovers = (client: string) => (existsSync(evictedIn(client)) ? readdirSync(evictedIn(client)) : []);

const UUID = '11111111-2222-4333-8444-555555555555';
const INTERRUPTED = `subject-${UUID}`;

function interruptedEviction(parked = true): void {
  mkdirSync(evictedIn('a'), { recursive: true });
  writeFileSync(join(evictedIn('a'), `${INTERRUPTED}.json`), '');
  if (parked) mkdirSync(join(evictedIn('a'), INTERRUPTED, 'src'), { recursive: true });
}

function externalDir(name: string, owner: string | null = 'key'): { dir: string; key: string; aside: string } {
  const dir = join(home, 'sw', name);
  mkdirSync(dir, { recursive: true });
  if (owner !== null) writeFileSync(`${dir}.owner`, owner);
  return { dir, key: 'key', aside: `${dir}.evicted-${UUID}` };
}

function reportExternalDirs(dirs: Array<{ dir: string; key: string }>): void {
  const original: unknown = Reflect.get(BuildWorkerRoot.prototype, 'externalDirs');
  Reflect.set(BuildWorkerRoot.prototype, 'externalDirs', () => dirs);
  onTestFinished(() => void Reflect.set(BuildWorkerRoot.prototype, 'externalDirs', original));
}

test('a failed delete is reported as what happened, once, and a later pass finishes it', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const restore = failDeletionOf((target) => dirname(target) === evictedIn('a') && !target.endsWith('.json'));
  const host = start();
  await host.evictAreas();
  await host.evictAreas();
  expect(existsSync(path)).toBe(false);
  expect(leftovers('a')).toHaveLength(2);
  expect(removed()).toEqual([]);
  expect(
    logs.filter((line) => /moved the build area a\/subject out of repos .* could not delete it/.test(line)),
  ).toHaveLength(1);
  expect(logs.filter((line) => /could not/.test(line))).toHaveLength(1);

  restore();
  await host.evictAreas();
  expect(leftovers('a')).toEqual([]);
  expect(logs.join('\n')).toMatch(/finished deleting the evicted build area a\/subject-/);
});

test('an external directory that cannot be deleted keeps the evicted area and its record until it can', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const external = externalDir('abc');
  reportExternalDirs([external]);
  const restore = failDeletionOf((target) => target.startsWith(`${external.dir}.evicted-`));
  const host = start();
  await host.evictAreas();
  expect(existsSync(path)).toBe(false);
  expect(existsSync(external.dir)).toBe(false);
  expect(readdirSync(join(home, 'sw')).filter((name) => name.startsWith('abc.evicted-'))).toHaveLength(1);
  expect(leftovers('a')).toHaveLength(2);
  expect(removed()).toEqual([]);

  restore();
  await host.evictAreas();
  expect(readdirSync(join(home, 'sw'))).toEqual([]);
  expect(leftovers('a')).toEqual([]);
});

test.each([
  { name: 'before its external directory moved', moved: false },
  { name: 'after its external directory moved', moved: true },
])('a new server finishes an eviction interrupted $name', async ({ moved }) => {
  area('a', 'newest', 0);
  const external = externalDir('abc');
  reportExternalDirs([external]);
  if (moved) fs.renameSync(external.dir, external.aside);
  interruptedEviction();
  await start().evictAreas();
  expect(existsSync(external.dir)).toBe(false);
  expect(existsSync(external.aside)).toBe(false);
  expect(existsSync(`${external.dir}.owner`)).toBe(false);
  expect(leftovers('a')).toEqual([]);
});

test('an external directory stays with a new area of the same repository', async () => {
  area('a', 'newest', 0);
  const fresh = area('a', 'subject', 0);
  const external = externalDir('abc');
  reportExternalDirs([external]);
  interruptedEviction();
  await start().evictAreas();
  expect(existsSync(external.dir)).toBe(true);
  expect(existsSync(`${external.dir}.owner`)).toBe(true);
  expect(existsSync(fresh)).toBe(true);
  expect(leftovers('a')).toEqual([]);
});

test.each([
  { name: 'another owner', owner: 'other-key', says: /its owner marker names another area/ },
  { name: 'no owner', owner: null, says: /it has no owner marker/ },
])('a short directory of $name stays, with its marker, and the eviction still finishes', async ({ owner, says }) => {
  area('a', 'newest', 0);
  const external = externalDir('abc', owner);
  reportExternalDirs([external]);
  interruptedEviction();
  await start().evictAreas();
  expect(existsSync(external.dir)).toBe(true);
  expect(existsSync(`${external.dir}.owner`)).toBe(owner !== null);
  expect(existsSync(external.aside)).toBe(false);
  expect(leftovers('a')).toEqual([]);
  expect(logs.join('\n')).toMatch(says);
});

test('a first eviction leaves a short directory that names another owner', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const external = externalDir('abc', 'other-key');
  reportExternalDirs([external]);
  await start().evictAreas();
  expect(existsSync(path)).toBe(false);
  expect(existsSync(external.dir)).toBe(true);
  expect(removed()).toEqual(['a/subject']);
});

test('a record marking an eviction whose rename never happened leaves the area alone', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 0);
  interruptedEviction(false);
  await start().evictAreas();
  expect(existsSync(join(path, 'src', 'file'))).toBe(true);
  expect(leftovers('a')).toEqual([]);
});

test('an interrupted eviction waits while the area claim is held, naming why once', async () => {
  area('a', 'newest', 0);
  const external = externalDir('abc');
  reportExternalDirs([external]);
  interruptedEviction();
  const claim = tryAcquireClaim({ root: `${areaPath('a', 'subject')}.claims`, mode: 'exclusive' }).acquired;
  assert(claim);
  const host = start();
  await host.evictAreas();
  await host.evictAreas();
  expect(existsSync(external.dir)).toBe(true);
  expect(leftovers('a')).toHaveLength(2);
  expect(logs.filter((line) => /could not finish deleting .* is held/.test(line))).toHaveLength(1);
  expect(logs.join('\n')).toContain(join(evictedIn('a'), INTERRUPTED));

  releaseClaim(claim);
  await host.evictAreas();
  expect(existsSync(external.dir)).toBe(false);
  expect(leftovers('a')).toEqual([]);
});

test.each(['...json', '..json', '.json', 'x.json', `..-${UUID}.json`, `a-${UUID}x.json`])(
  'a record named %s is logged and kept, and nothing is deleted for it',
  async (name) => {
    const newest = area('a', 'newest', 0);
    mkdirSync(join(evictedIn('a'), `pending-${UUID}`), { recursive: true });
    writeFileSync(join(evictedIn('a'), 'other-file'), '');
    writeFileSync(join(evictedIn('a'), name), '');
    await start().evictAreas();
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(join(evictedIn('a'), name))).toBe(true);
    expect(existsSync(join(evictedIn('a'), `pending-${UUID}`))).toBe(true);
    expect(existsSync(join(evictedIn('a'), 'other-file'))).toBe(true);
    expect(logs.filter((line) => line.includes(`keeping ${join(evictedIn('a'), name)}`))).toHaveLength(1);
  },
);

test.each([
  {
    name: 'its record cannot be created',
    fail: () => {
      const write = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
        if (String(target).startsWith(evictedIn('a'))) throw new Error('fixture: disk full');
        write(target, ...rest);
      });
    },
  },
  {
    name: 'it cannot be renamed',
    fail: () => {
      const rename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(from) === areaPath('a', 'subject')) throw new Error('fixture: busy');
        rename(from, to);
      });
    },
  },
])('an area stays whole, with nothing left aside, when $name', async ({ fail }) => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const host = start();
  fail();
  syncBuiltinESMExports();
  await host.evictAreas();
  expect(existsSync(join(path, 'src', 'file'))).toBe(true);
  expect(leftovers('a')).toEqual([]);
  expect(logs.join('\n')).toMatch(/retaining the build area a\/subject: it could not be moved aside/);
});

test('a record contents carry no authority', async () => {
  area('a', 'newest', 0);
  reportExternalDirs([externalDir('abc')]);
  const victim = join(home, 'victim');
  const other = join(home, 'other');
  mkdirSync(victim);
  mkdirSync(other);
  mkdirSync(evictedIn('a'), { recursive: true });
  writeFileSync(
    join(evictedIn('a'), `subject-${UUID}.json`),
    JSON.stringify({ repo: '../../../traversal', external: [{ dir: other, aside: victim }] }),
  );
  await start().evictAreas();
  expect(existsSync(victim)).toBe(true);
  expect(existsSync(other)).toBe(true);
  expect(readdirSync(home)).not.toContain('traversal.claims');
  expect(existsSync(join(home, 'sw', 'abc'))).toBe(false);
  expect(leftovers('a')).toEqual([]);
});

test('a forged repository in a record takes no claim outside the client', async () => {
  area('a', 'newest', 0);
  reportExternalDirs([externalDir('abc')]);
  mkdirSync(evictedIn('a'), { recursive: true });
  writeFileSync(join(evictedIn('a'), `..-${UUID}.json`), JSON.stringify({ repo: '../../../traversal' }));
  await start().evictAreas();
  expect(readdirSync(root).filter((name) => name.endsWith('.claims'))).toEqual([]);
  expect(readdirSync(join(root, 'a', 'repos')).filter((name) => name.endsWith('.claims'))).toEqual([]);
  expect(existsSync(join(home, 'sw', 'abc'))).toBe(true);
});

test('a symlinked evicted folder is not followed, and blocks evicting into it', async () => {
  area('a', 'newest', 0);
  const old = area('a', 'old', 30);
  const outside = join(home, 'outside');
  mkdirSync(join(outside, `z-${UUID}`), { recursive: true });
  writeFileSync(join(outside, `z-${UUID}.json`), '');
  symlinkSync(outside, evictedIn('a'), 'junction');
  await start().evictAreas();
  expect(existsSync(join(outside, `z-${UUID}`))).toBe(true);
  expect(existsSync(join(outside, `z-${UUID}.json`))).toBe(true);
  expect(existsSync(old)).toBe(true);
  expect(readdirSync(outside)).toHaveLength(2);
  expect(logs.filter((line) => line.includes('is not a real directory')).length).toBeGreaterThan(0);
});

test('revoking a symlinked client does not act on what the link points at', async () => {
  const outside = join(home, 'outside');
  mkdirSync(join(outside, 'evicted', `z-${UUID}`), { recursive: true });
  writeFileSync(join(outside, 'evicted', `z-${UUID}.json`), '');
  const staging = join(outside, 'repos', 'subject.claims', '.staging-backup');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'user-data'), 'keep');
  symlinkSync(outside, join(root, 'linked'), 'junction');
  await start().remove('linked');
  expect(existsSync(join(outside, 'evicted', `z-${UUID}`))).toBe(true);
  expect(readFileSync(join(staging, 'user-data'), 'utf8')).toBe('keep');
});

function linkedClaims(repo: string): string {
  const outside = join(home, 'outside');
  mkdirSync(join(outside, '.staging-backup'), { recursive: true });
  writeFileSync(join(outside, '.staging-backup', 'user-data'), 'x');
  symlinkSync(outside, `${areaPath('a', repo)}.claims`, 'junction');
  return join(outside, '.staging-backup', 'user-data');
}

test('a symlinked claim store is not written through, and its area stays', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const data = linkedClaims('subject');
  await start().evictAreas();
  expect(existsSync(data)).toBe(true);
  expect(readdirSync(dirname(dirname(data)))).toEqual(['.staging-backup']);
  expect(existsSync(path)).toBe(true);
  expect(logs.join('\n')).toMatch(/retaining the build area a\/subject: .*subject\.claims is not a real directory/);
});

test('revoking a client does not clear a claim store through a symlink', async () => {
  area('a', 'subject', 30);
  const data = linkedClaims('subject');
  await start().remove('a');
  expect(existsSync(data)).toBe(true);
  expect(existsSync(join(root, 'a'))).toBe(false);
});

test.each([
  { name: 'recordAreaUse', file: 'last-used', write: (dir: string) => recordAreaUse(dir) },
  {
    name: 'recordRootUsage',
    file: 'usage.json',
    write: (dir: string) => recordRootUsage({ path: dir, bytes: 1, measuredAt: new Date().toISOString() }),
  },
])(
  '$name does not write through a planted temp file, and still records',
  { skip: process.platform === 'win32' },
  ({ file, write }) => {
    const temp = `${file}.${process.pid}.tmp`;
    const victim = join(home, 'victim');
    writeFileSync(victim, 'keep');
    const dir = join(home, 'target');
    mkdirSync(dir);
    symlinkSync(victim, join(dir, temp));
    write(dir);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(fs.lstatSync(join(dir, file)).isFile()).toBe(true);
  },
);

test('a symlinked repos folder is not listed as areas', async () => {
  const projects = join(home, 'projects');
  for (const project of ['projA', 'projB']) {
    mkdirSync(join(projects, project), { recursive: true });
    writeFileSync(join(projects, project, 'last-used'), String(Date.now() - 30 * DAY));
  }
  mkdirSync(join(projects, 'projA.claims'));
  mkdirSync(join(root, 'a'));
  symlinkSync(projects, join(root, 'a', 'repos'), 'junction');
  const host = start();
  await host.evictAreas();
  await host.evictAreas();
  expect(readdirSync(projects).toSorted()).toEqual(['projA', 'projA.claims', 'projB']);
  expect(logs.filter((line) => line.includes('is not a real directory'))).toHaveLength(1);
  await host.remove('a');
  expect(readdirSync(projects).toSorted()).toEqual(['projA', 'projA.claims', 'projB']);
});

test('an interrupted eviction takes no claim through a symlinked repos folder', async () => {
  const projects = join(home, 'projects');
  mkdirSync(projects);
  mkdirSync(join(root, 'a'));
  symlinkSync(projects, join(root, 'a', 'repos'), 'junction');
  const external = externalDir('abc');
  reportExternalDirs([external]);
  interruptedEviction();
  await start().evictAreas();
  expect(readdirSync(projects)).toEqual([]);
  expect(existsSync(external.dir)).toBe(true);
  expect(leftovers('a')).toHaveLength(2);
});

test("one client's evicted file stops neither the pass nor another client's eviction", async () => {
  area('a', 'newest', 0);
  const kept = area('a', 'old', 30);
  writeFileSync(evictedIn('a'), '');
  area('b', 'newest', 0);
  const old = area('b', 'old', 30);
  const host = start();
  await host.evictAreas();
  expect(existsSync(old)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(logs.join('\n')).toMatch(/retaining the build area a\/old: .* is not a real directory/);

  await host.remove('a');
  expect(existsSync(join(root, 'a'))).toBe(false);
});

test('a removal that fails is logged and does not reject', async () => {
  const host = start();
  const original: unknown = Reflect.get(BuildWorkerRoot.prototype, 'removeClient');
  Reflect.set(BuildWorkerRoot.prototype, 'removeClient', () => Promise.reject(new Error('fixture: refused')));
  onTestFinished(() => void Reflect.set(BuildWorkerRoot.prototype, 'removeClient', original));
  await expect(host.remove('a')).resolves.toBeUndefined();
  expect(logs.join('\n')).toMatch(/retaining the build area of a: Error: fixture: refused/);
});

test('a pass and a revocation work through the same records one at a time, and the client still goes', async () => {
  area('a', 'newest', 0);
  mkdirSync(evictedIn('a'), { recursive: true });
  for (const repo of ['one', 'two']) {
    writeFileSync(join(evictedIn('a'), `${repo}-${UUID}.json`), '');
    mkdirSync(join(evictedIn('a'), `${repo}-${UUID}`));
  }
  let inFlight = 0;
  let most = 0;
  let open: () => void = () => {};
  const started = new Promise<void>((resolve) => (open = resolve));
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const remove = fsPromises.rm;
  vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (typeof path !== 'string' || dirname(path) !== evictedIn('a')) return remove(path, options);
    inFlight += 1;
    most = Math.max(most, inFlight);
    open();
    await blocked;
    await remove(path, options);
    inFlight -= 1;
  });
  syncBuiltinESMExports();
  const host = start();
  const pass = host.evictAreas();
  await started;
  const revoking = host.remove('a');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([pass, revoking]);
  expect(most).toBe(1);
  expect(existsSync(join(root, 'a'))).toBe(false);
});

test("revoking a client finishes its evictions first, and keeps the client while one can't", async () => {
  area('a', 'newest', 0);
  const external = externalDir('abc');
  reportExternalDirs([external]);
  fs.renameSync(external.dir, external.aside);
  interruptedEviction();
  const restore = failDeletionOf((target) => target === external.aside);
  const host = start();
  await host.remove('a');
  expect(existsSync(join(root, 'a'))).toBe(true);
  expect(existsSync(external.aside)).toBe(true);

  restore();
  await host.remove('a');
  expect(existsSync(join(root, 'a'))).toBe(false);
  expect(existsSync(external.aside)).toBe(false);
});

test('closing does not wait for a deletion, and a closed server starts none', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 30);
  const { reached, release } = gateRemovalOf((target) => dirname(target) === evictedIn('a'));
  const host = start();
  const pass = host.evictAreas();
  await reached;
  await host.close();
  expect(existsSync(path)).toBe(false);
  release();
  await pass;

  interruptedEviction();
  await host.evictAreas();
  expect(leftovers('a')).toHaveLength(2);
});

test(
  'windows short directories go with their area, junction and all',
  { skip: process.platform !== 'win32' },
  async () => {
    vi.stubEnv('SystemDrive', home);
    area('a', 'newest', 0);
    const path = areaPath('a', 'subject');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'last-used'), String(Date.now() - 30 * DAY));
    const real = fs.realpathSync(path);
    const checkout = windowsShortDir(real);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'file'), 'x');
    writeFileSync(`${checkout}.owner`, windowsShortDirKey('checkout', real));
    symlinkSync(checkout, join(path, 'src'), 'junction');
    const gradle = windowsShortDir(join(path, 'cache', 'gradle'));
    mkdirSync(gradle, { recursive: true });
    writeFileSync(`${gradle}.owner`, windowsShortDirKey('gradle', path));
    await start().evictAreas();

    expect(removed()).toEqual(['a/subject']);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(checkout))).toEqual([]);
    expect(leftovers('a')).toEqual([]);
  },
);

function windowsArea(repo: string): { path: string; checkout: string; gradle: string } {
  vi.stubEnv('SystemDrive', home);
  const path = areaPath('a', repo);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'last-used'), String(Date.now() - 30 * DAY));
  const real = fs.realpathSync(path);
  const checkout = windowsShortDir(real);
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'file'), 'x');
  writeFileSync(`${checkout}.owner`, windowsShortDirKey('checkout', real));
  symlinkSync(checkout, join(path, 'src'), 'junction');
  const gradle = windowsShortDir(win32.join(path, 'cache', 'gradle'));
  mkdirSync(gradle, { recursive: true });
  writeFileSync(`${gradle}.owner`, windowsShortDirKey('gradle', path));
  return { path, checkout, gradle };
}

test(
  "revoking a Windows client preserves another client's checkout behind a junction",
  { skip: process.platform !== 'win32' },
  async () => {
    const { path, checkout } = windowsArea('subject');
    const repos = join(root, 'revoked', 'repos');
    mkdirSync(repos, { recursive: true });
    symlinkSync(path, join(repos, 'subject.claims'), 'junction');

    await start().remove('revoked');

    expect(existsSync(join(root, 'revoked'))).toBe(false);
    expect(readFileSync(join(checkout, 'file'), 'utf8')).toBe('x');
    expect(existsSync(`${checkout}.owner`)).toBe(true);
  },
);

test.each([true, false])(
  'revoking a Windows client deletes its short checkout only with a matching owner (%s)',
  { skip: process.platform !== 'win32' },
  async (owned) => {
    const { checkout } = windowsArea('subject');
    if (!owned) writeFileSync(`${checkout}.owner`, 'another-area');

    await start().remove('a');

    expect(existsSync(join(root, 'a'))).toBe(false);
    expect(existsSync(join(checkout, 'file'))).toBe(!owned);
    expect(existsSync(`${checkout}.owner`)).toBe(!owned);
  },
);

test(
  'recovery on windows derives the same short directories eviction used',
  { skip: process.platform !== 'win32' },
  async () => {
    area('a', 'newest', 0);
    const { path, checkout, gradle } = windowsArea('subject');
    mkdirSync(evictedIn('a'), { recursive: true });
    writeFileSync(join(evictedIn('a'), `${INTERRUPTED}.json`), '');
    fs.renameSync(path, join(evictedIn('a'), INTERRUPTED));
    await start().evictAreas();
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(`${checkout}.owner`)).toBe(false);
    expect(existsSync(gradle)).toBe(false);
    expect(readdirSync(dirname(checkout))).toEqual([]);
    expect(leftovers('a')).toEqual([]);
  },
);

test(
  'deleting an evicted area on windows does not follow its junction into a short directory a new area took back',
  { skip: process.platform !== 'win32' },
  async () => {
    area('a', 'newest', 0);
    const { path, checkout } = windowsArea('subject');
    mkdirSync(evictedIn('a'), { recursive: true });
    writeFileSync(join(evictedIn('a'), `${INTERRUPTED}.json`), '');
    fs.renameSync(path, join(evictedIn('a'), INTERRUPTED));
    mkdirSync(path);
    symlinkSync(checkout, join(path, 'src'), 'junction');
    await start().evictAreas();
    expect(leftovers('a')).toEqual([]);
    expect(readFileSync(join(checkout, 'file'), 'utf8')).toBe('x');
    expect(readFileSync(join(path, 'src', 'file'), 'utf8')).toBe('x');
  },
);

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
  expect(logs.join('\n')).toMatch(/an offload job is using it/);

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

test('keeps an area a running offload job uses until the job ends', async () => {
  area('a', 'newest', 0);
  const synced = area('a', 'synced', 30);
  const host = start();
  const end = host.connect('a', 'synced');
  await host.evictAreas();
  expect(existsSync(synced)).toBe(true);
  expect(logs.join('\n')).toMatch(/an offload job is using it/);

  end();
  await host.evictAreas();
  expect(existsSync(synced)).toBe(false);
});

test('serving a cached artifact counts as use', async () => {
  area('a', 'newest', 1);
  const path = area('a', 'subject', 30);
  const archive = join(home, 'artifact');
  writeFileSync(archive, 'x');
  const artifact = { ...IDENTITY, name: 'App.app', size: 1, sha256: sha('x') };
  vi.spyOn(BuildArtifactCache.prototype, 'lookup').mockResolvedValue(artifact);
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
  symlinkSync(outside, join(root, 'linked'), 'junction');
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

test("pruning after eviction preserves another client's blobs behind a junction", async () => {
  area('a', 'subject', 30);
  area('a', 'newest', 0);
  const otherBlobs = join(root, 'b', 'blobs');
  const blob = join(otherBlobs, sha('keep').slice(0, 2), sha('keep'));
  mkdirSync(dirname(blob), { recursive: true });
  writeFileSync(blob, 'keep');
  symlinkSync(otherBlobs, join(root, 'a', 'blobs'), 'junction');

  await start().evictAreas();

  expect(removed()).toEqual(['a/subject']);
  expect(readFileSync(blob, 'utf8')).toBe('keep');
});

test(
  'cleanup does not open usage or mirror records that are named pipes',
  { skip: process.platform === 'win32' },
  async () => {
    const path = area('a', 'newest', null);
    area('a', 'subject', 30);
    const records = [join(path, 'last-used'), join(path, 'mirror.json')];
    expect(spawnSync('mkfifo', records).status).toBe(0);
    const read = fs.readFileSync;
    const attempted: string[] = [];
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (typeof file === 'string' && records.includes(file)) {
        attempted.push(file);
        throw new Error('fixture: opening a named pipe would block');
      }
      return read(file, options);
    });
    syncBuiltinESMExports();

    await start().evictAreas();

    expect(removed()).toEqual(['a/subject']);
    expect(attempted).toEqual([]);
  },
);

test('a job starting near the floor starts a pass and its build is admitted without waiting for the deletion', async () => {
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
    await vi.waitFor(() => {
      expect(host.workerRootUsage()?.bytes).toEqual(expect.any(Number));
      expect(host.workerRootUsage()?.bytes).not.toBe(42);
    });
    expect(JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')).bytes).toBe(host.workerRootUsage()?.bytes);
  },
);

test(
  'a missing root reports not measured instead of a fresh zero, until it comes back',
  { skip: process.platform === 'win32' },
  async () => {
    rmSync(root, { recursive: true, force: true });
    const host = start({ daemonSweepMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.workerRootUsage()).toBeNull();

    mkdirSync(root);
    await vi.waitFor(() => expect(host.workerRootUsage()?.path).toBe(root));
  },
);

test('a recorded measurement is reported before the first check', () => {
  const measuredAt = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(join(root, 'usage.json'), JSON.stringify({ bytes: 42, measuredAt }));
  expect(start().workerRootUsage()).toEqual({ path: root, bytes: 42, measuredAt });
});

test('a bundle that cannot be deleted does not pin its area', async () => {
  area('a', 'newest', 0);
  const path = area('a', 'subject', 0);
  const host = start();
  const job = launch(host, 'a', 'subject');
  assert(!('error' in job));
  await job.done;
  writeFileSync(join(areaPath('a', 'newest'), 'last-used'), String(Date.now()));
  writeFileSync(join(path, 'last-used'), String(Date.now() - 30 * DAY));
  const token = host.retain(job, { name: 'App.app', size: 1, sha256: sha('x') });
  assert(token);
  host.forget(job);
  const taken = host.takeBundle(token, sha('x'), () => true);
  assert(typeof taken !== 'string');
  const bundleDir = dirname(taken.bundle);
  const remove = fs.rmSync;
  vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (target === bundleDir) throw new Error('fixture: busy');
    remove(target, options);
  });
  syncBuiltinESMExports();
  expect(() => taken.release()).toThrow('fixture: busy');
  vi.mocked(fs.rmSync).mockRestore();
  syncBuiltinESMExports();
  await host.evictAreas();
  expect(existsSync(path)).toBe(false);
});

test('a symlinked root reports the size of what it points at', { skip: process.platform === 'win32' }, async () => {
  const target = join(home, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'big'), Buffer.alloc(1024 * 1024));
  const link = join(home, 'link');
  symlinkSync(target, link);
  config({ workerRoot: link });
  const host = start({ daemonSweepMs: 5 });
  await vi.waitFor(() => expect(host.workerRootUsage()?.bytes).toBeGreaterThanOrEqual(1024 * 1024));
});

test('after an unmount or a change of root the old size is no longer reported', async () => {
  const measuredAt = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(join(root, 'usage.json'), JSON.stringify({ bytes: 42, measuredAt }));
  const host = start();
  expect(host.workerRootUsage()).toEqual({ path: root, bytes: 42, measuredAt });

  const other = join(home, 'other-root');
  config({ workerRoot: other });
  expect(host.workerRootUsage()).toBeNull();

  config({});
  expect(host.workerRootUsage()).toEqual({ path: root, bytes: 42, measuredAt });
  rmSync(root, { recursive: true });
  expect(host.workerRootUsage()).toBeNull();
});
