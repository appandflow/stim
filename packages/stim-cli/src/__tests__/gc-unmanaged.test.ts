import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonPressure } from '@stim-cli/core/state';
import { parseProcSwaps, unmanagedUsage } from '../commands/gc/unmanaged.ts';
import { formatUnmanagedUsage } from '../commands/gc/summary.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { upsertProject } from '../workspace/config.ts';
import type { LevelRun } from '../stimd/passes/level-run.ts';
import { discoverCachesAsync } from '../cache/caches.ts';
import { testContext } from './_context.ts';

const hooks: {
  lstat: ((path: string) => void | Partial<Stats>) | null;
  realpath: ((path: string) => Promise<string> | null) | null;
} = vi.hoisted(() => ({ lstat: null, realpath: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string) => {
      const stats = await actual.lstat(path);
      return Object.assign(stats, hooks.lstat?.(path) ?? {});
    },
    realpath: (path: string) => hooks.realpath?.(path) ?? actual.realpath(path),
  };
});

let root: string;
let home: string;
let temp: string;
let calls: string[][];
let docker: string | null;
let slow: string | null;
let dockerOutput: string | Error;

const DOCKER_DF = [
  '{"Active":"2","Reclaimable":"1.5GB (60%)","Size":"2.5GB","TotalCount":"4","Type":"Images"}',
  '{"Active":"0","Reclaimable":"0B","Size":"0B","TotalCount":"0","Type":"Containers"}',
  '{"Active":"1","Reclaimable":"0B","Size":"500MB","TotalCount":"1","Type":"Local Volumes"}',
].join('\n');

function levelRun(pressure: Partial<DaemonPressure>, wouldBytes = 0, cachePaths: string[] = []): LevelRun {
  return {
    pressure: { level: 'high', disk: 'high', memory: 'normal', reasons: [], memoryWarningSince: null, ...pressure },
    level: 'high',
    actions: wouldBytes
      ? [
          {
            rung: 1,
            kind: 'trim-cache',
            target: home,
            outcome: 'would',
            bytes: wouldBytes,
            reason: '',
            detail: '',
          },
        ]
      : [],
    blocked: [],
    discovered: [],
    outside: [],
    usage: [],
    cachePaths,
  };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-unmanaged-')));
  home = join(root, 'home');
  temp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(temp);
  vi.stubEnv('HOME', home);
  vi.stubEnv('TMPDIR', temp);
  vi.stubEnv('STIM_HOME', '');
  vi.stubEnv('STIM_DISK_MIN_FREE_GB', '1000000');
  calls = [];
  hooks.lstat = null;
  hooks.realpath = null;
  docker = null;
  slow = null;
  dockerOutput = DOCKER_DF;
  setExecutor({
    findExecutable: (name: string) => (name === 'docker' ? docker : null),
    runFileAsync: async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === 'docker') {
        if (dockerOutput instanceof Error) throw dockerOutput;
        return dockerOutput;
      }
      const dir = args.at(-1) ?? '';
      if (dir === slow) {
        vi.setSystemTime(Date.now() + 60_000);
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      }
      if (dir.endsWith('unreadable'))
        throw Object.assign(new Error('Permission denied'), { status: 1, stdout: `512\t${dir}\n` });
      if (dir.endsWith('broken')) throw Object.assign(new Error('du failed'), { status: 2, stdout: '' });
      return `${dir.endsWith('big') ? 4_194_304 : 1024}\t${dir}\n`;
    },
  });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test.each([
  ['the disk level is normal', () => levelRun({ level: 'high', disk: 'normal', memory: 'high' }), ''],
  ['STIM_HOME scopes the home', () => levelRun({}), 'scoped'],
])('scans nothing when %s', async (_case, run, scoped) => {
  if (scoped) vi.stubEnv('STIM_HOME', join(root, scoped));
  mkdirSync(join(home, 'big'));
  docker = '/usr/bin/docker';
  expect(await unmanagedUsage(run(), false)).toBeNull();
  expect(calls).toEqual([]);
});

test('names the largest users Stim does not manage, skips its own, and tells slow walks from failed ones', async () => {
  for (const dir of [
    'big',
    'broken',
    'cache',
    'Developer/app',
    '.stim/build-cache',
    'data-unreadable',
    'huge',
    'later',
  ])
    mkdirSync(join(home, dir), { recursive: true });
  upsertProject(join(home, 'Developer', 'app'), {});
  writeFileSync(join(home, 'notes.txt'), 'x'.repeat(8192));
  symlinkSync(join(home, 'big'), join(home, 'link'));
  for (const dir of ['scratch', 'stim-ws-1', '.stim-delete-old', 'TemporaryDirectory.Ab12Cd'])
    mkdirSync(join(temp, dir));
  writeFileSync(join(temp, 'instruments1.ktrace'), 'trace');
  slow = join(home, 'huge');

  const usage = await unmanagedUsage(levelRun({}), false);

  const ours = usage?.entries.filter((entry) => entry.label.startsWith(root));
  expect(ours).toEqual([
    { label: join(home, 'big'), bytes: 4_294_967_296 },
    { label: join(temp, 'scratch'), bytes: 1_048_576 },
    { label: join(home, 'Developer'), bytes: 1_048_576, holdsStim: true },
    { label: join(home, 'cache'), bytes: 1_048_576 },
    { label: join(home, 'data-unreadable'), bytes: 524_288, partial: true },
    { label: join(home, 'notes.txt'), bytes: expect.any(Number) },
  ]);
  expect(usage).toMatchObject({ slow: [join(home, 'huge')], failed: [join(home, 'broken')], unreached: 1 });
  expect(calls.every(([file, ...args]) => file === 'nice' && args.slice(0, 5).join(' ') === '-n 19 du -x -sk')).toBe(
    true,
  );
  const lines = usage ? formatUnmanagedUsage({ ...usage, entries: ours?.slice(3) ?? [] }) : [];
  expect(lines).toContain("Not Stim's to delete, the largest other users of the short volume:");
  expect(lines).toContain(`  too slow to size, likely large: ${join(home, 'huge')}`);
  expect(lines).toContain(`  could not be sized: ${join(home, 'broken')}`);
  expect(lines).toContain(`  512K or more  ${join(home, 'data-unreadable')}, partly unreadable`);
  expect(lines).toContain('  1 more entry not reached within the time budget');
});

test('asks Docker for its usage only when it is installed, with its own cleanup command', async () => {
  expect((await unmanagedUsage(levelRun({}), false))?.entries.some((entry) => entry.label.startsWith('Docker'))).toBe(
    false,
  );
  expect(calls).toEqual([]);
  docker = '/usr/bin/docker';
  const usage = await unmanagedUsage(levelRun({}), true);
  expect(usage?.entries).toContainEqual({
    label: 'Docker images, containers, volumes and build cache, possibly on another volume, 1.4G reclaimable',
    bytes: 3_000_000_000,
    command: 'docker system prune',
  });
  dockerOutput = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  expect((await unmanagedUsage(levelRun({}), false))?.slow).toEqual(['Docker (docker system df)']);
});

test('reads swap files, not swap partitions, from /proc/swaps', () => {
  expect(
    parseProcSwaps(
      [
        'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority',
        '/swapfile                               file\t\t33554428\t1048576\t\t-2',
        '/dev/nvme0n1p3                          partition\t8388604\t\t0\t\t-3',
        '/data/my\\040swap                         file\t\t1024\t\t0\t\t-4',
      ].join('\n'),
    ),
  ).toEqual([
    { path: '/swapfile', bytes: 33_554_428 * 1024 },
    { path: '/data/my swap', bytes: 1024 * 1024 },
  ]);
});

test('a dry run that would free a lot still lists the disk as it is now', async () => {
  mkdirSync(join(home, 'big'));

  const usage = await unmanagedUsage(levelRun({}, Number.MAX_SAFE_INTEGER), false);

  expect(usage?.entries).toContainEqual({ label: join(home, 'big'), bytes: 4_294_967_296 });
  expect(usage ? formatUnmanagedUsage(usage) : []).toContain(
    '  This is the disk as it is now, before the deletions this dry run lists.',
  );
});

test('stops listing a folder once the time budget is spent', async () => {
  for (let index = 0; index < 10; index += 1) mkdirSync(join(home, `dir-${index}`));
  const started = Date.now();
  hooks.lstat = (path) => {
    if (path.startsWith(home)) vi.setSystemTime(Date.now() + 2000);
  };

  const usage = await unmanagedUsage(levelRun({}), false);

  expect(Date.now() - started).toBeLessThanOrEqual(17_000);
  expect(usage?.unreached).toBe(10);
  expect(calls).toEqual([]);
});

test('a cancelled gc stops the listing', async () => {
  for (let index = 0; index < 10; index += 1) mkdirSync(join(home, `dir-${index}`));
  const controller = new AbortController();
  let reads = 0;
  hooks.lstat = (path) => {
    if (!path.startsWith(home)) return;
    reads += 1;
    controller.abort();
  };

  await expect(unmanagedUsage(levelRun({}), false, testContext({ signal: controller.signal }))).rejects.toThrow(
    /abort/i,
  );
  expect(reads).toBe(1);
  expect(calls).toEqual([]);
});

test('leaves out a cache Stim manages before it is measured', async () => {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  mkdirSync(join(temp, `jest_${uid.toString(36)}`, 'haste-map-abc123-app'), { recursive: true });
  writeFileSync(join(temp, 'metro-file-map-abc123'), 'map');
  mkdirSync(join(temp, 'scratch'));

  const caches = await discoverCachesAsync();
  const usage = await unmanagedUsage(
    levelRun({}, 0, [...caches.map((cache) => cache.dir), ...caches.flatMap((cache) => cache.files ?? [])]),
    false,
  );

  expect(usage?.entries.map((entry) => entry.label).filter((label) => label.startsWith(temp))).toEqual([
    join(temp, 'scratch'),
  ]);
});

describe('a path Stim manages that does not resolve in time', () => {
  let release: (() => void) | null = null;
  let reached: Promise<void>;

  beforeEach(() => {
    mkdirSync(join(home, 'big'));
    let arrive = () => {};
    reached = new Promise((resolve) => {
      arrive = resolve;
    });
    hooks.realpath = (path) => {
      if (path !== home) return null;
      arrive();
      return new Promise<string>((resolve) => {
        release = () => resolve(path);
      });
    };
  });

  afterEach(async () => {
    release?.();
    release = null;
    await vi.advanceTimersByTimeAsync(0);
  });

  test('leaves the temp and home folders out once the deadline passes', async () => {
    const pending = unmanagedUsage(levelRun({}), false);
    await reached;
    await vi.advanceTimersByTimeAsync(16_000);
    const usage = await pending;

    expect(usage?.entries.some((entry) => entry.label.startsWith(root))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('stops at once when gc is cancelled', async () => {
    const controller = new AbortController();
    const pending = unmanagedUsage(levelRun({}), false, testContext({ signal: controller.signal }));
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await reached;
    controller.abort();
    expect(await outcome).toMatch(/abort/i);
    expect(calls).toEqual([]);
  });
});

test('lists a home folder named like a Stim temp leftover, and skips that name only in the temp folder', async () => {
  mkdirSync(join(home, 'stim-demo'));
  mkdirSync(join(temp, 'stim-ws-1'));

  const labels = (await unmanagedUsage(levelRun({}), false))?.entries.map((entry) => entry.label) ?? [];

  expect(labels).toContain(join(home, 'stim-demo'));
  expect(labels).not.toContain(join(temp, 'stim-ws-1'));
});

test('on macOS names the home folders macOS protects and never reads them', async () => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });
  for (const dir of ['Documents', 'Library', 'projects']) mkdirSync(join(home, dir));
  const read: string[] = [];
  hooks.lstat = (path) => {
    read.push(path);
  };

  const usage = await unmanagedUsage(levelRun({}), false);

  expect(usage?.guarded).toEqual([join(home, 'Documents'), join(home, 'Library')]);
  expect(read).not.toContain(join(home, 'Documents'));
  expect(calls.map((call) => call.at(-1))).not.toContain(join(home, 'Library'));
  expect(usage ? formatUnmanagedUsage(usage) : []).toContain(
    `  not sized, macOS protects these: ${join(home, 'Documents')}, ${join(home, 'Library')}`,
  );
});
