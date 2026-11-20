import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonPressure } from '@stim-cli/core/state';
import { parseProcSwaps, unmanagedUsage } from '../commands/gc/unmanaged.ts';
import { formatUnmanagedUsage } from '../commands/gc/summary.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { backgroundWalk } from './_background-walk.ts';
import { upsertProject } from '../workspace/config.ts';
import type { LevelRun } from '../stimd/passes/level-run.ts';
import { discoverCachesAsync } from '../cache/caches.ts';
import { hungRead } from '../workspace/bounded-read.ts';
import { testContext } from './_context.ts';

const hooks: {
  lstat: ((path: string) => void | Partial<Stats>) | null;
  realpath: ((path: string) => Promise<string> | null) | null;
  volume: ((path: string) => { volume: string; freeMb: number; device: number } | null) | null;
  du: ((dir: string, signal?: AbortSignal) => Promise<string> | null) | null;
  dev: Record<string, number> | null;
} = vi.hoisted(() => ({ lstat: null, realpath: null, volume: null, du: null, dev: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string) => {
      const stats = await actual.lstat(path);
      return Object.assign(stats, hooks.lstat?.(path) ?? {});
    },
    realpath: (path: string) => hooks.realpath?.(path) ?? actual.realpath(path),
    readdir: (path: string, ...rest: []) =>
      path === '/dev' && hooks.dev ? Promise.resolve(Object.keys(hooks.dev)) : actual.readdir(path, ...rest),
    stat: (path: string) => {
      const rdev = path.startsWith('/dev/') ? hooks.dev?.[path.slice(5)] : undefined;
      return rdev === undefined ? actual.stat(path) : Promise.resolve({ rdev });
    },
  };
});

vi.mock('../stimd/passes/budget.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stimd/passes/budget.ts')>();
  return {
    ...actual,
    readVolumeSpaceAsync: async (paths: readonly string[], signal?: AbortSignal) => {
      const replaced = paths.length === 1 && paths[0] !== undefined ? hooks.volume?.(paths[0]) : null;
      return replaced ? [replaced] : actual.readVolumeSpaceAsync(paths, signal);
    },
  };
});

let root: string;
let home: string;
let temp: string;
let calls: string[][];
let docker: string | null;
let slow: string | null;
let dockerOutput: string | Error | 'hang';
let releaseDocker = () => {};

const DOCKER_DF = [
  '{"Active":"2","Reclaimable":"1.5GB (60%)","Size":"2.5GB","TotalCount":"4","Type":"Images"}',
  '{"Active":"0","Reclaimable":"0B","Size":"0B","TotalCount":"0","Type":"Containers"}',
  '{"Active":"1","Reclaimable":"0B","Size":"500MB","TotalCount":"1","Type":"Local Volumes"}',
].join('\n');

function levelRun(
  pressure: Partial<DaemonPressure>,
  wouldBytes = 0,
  cachePaths: string[] = [],
  sweptCachePaths: string[] = [],
): LevelRun {
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
    sweptCachePaths,
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
  hooks.volume = null;
  hooks.du = null;
  hooks.dev = null;
  docker = null;
  slow = null;
  dockerOutput = DOCKER_DF;
  setExecutor({
    findExecutable: (name: string) => (name === 'docker' ? docker : null),
    runFileAsync: async (file: string, args: string[], options?: { signal?: AbortSignal }) => {
      calls.push([file, ...args]);
      if (file === 'docker') {
        if (docker === null) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        if (dockerOutput === 'hang')
          return new Promise<string>((resolve) => {
            releaseDocker = () => resolve('');
          });
        if (dockerOutput instanceof Error) throw dockerOutput;
        return dockerOutput;
      }
      const dir = args.at(-1) ?? '';
      const hooked = hooks.du?.(dir, options?.signal);
      if (hooked) return hooked;
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

describe.skipIf(process.platform === 'win32')('the gate', () => {
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
});

test.skipIf(process.platform === 'win32')(
  'names the largest users Stim does not manage, skips its own, and tells slow walks from failed ones',
  async () => {
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
    expect(
      calls
        .filter(([file]) => file !== 'docker')
        .every(
          ([file, ...args]) =>
            backgroundWalk(file ?? '', args)
              ?.slice(0, 3)
              .join(' ') === 'du -x -sk',
        ),
    ).toBe(true);
    const lines = usage ? formatUnmanagedUsage({ ...usage, entries: ours?.slice(3) ?? [] }) : [];
    expect(lines).toContain("Not Stim's to delete, the largest other users of the short volume:");
    expect(lines).toContain(`  too slow to size, likely large: ${join(home, 'huge')}`);
    expect(lines).toContain(`  could not be sized: ${join(home, 'broken')}`);
    expect(lines).toContain(`  512K or more  ${join(home, 'data-unreadable')}, partly unreadable`);
    expect(lines).toContain('  1 more entry not reached within the time budget');
  },
);

test.skipIf(process.platform === 'win32')(
  'reads a missing docker as not installed, and asks an installed one with its own cleanup command',
  async () => {
    const absent = await unmanagedUsage(levelRun({}), false);
    expect(calls.filter(([file]) => file === 'docker')).toHaveLength(1);
    expect([...(absent?.entries ?? []), ...(absent?.slow ?? []), ...(absent?.failed ?? [])].join()).not.toMatch(
      /Docker/,
    );
    docker = '/usr/bin/docker';
    const usage = await unmanagedUsage(levelRun({}), true);
    expect(usage?.entries).toContainEqual({
      label: 'Docker images, containers, volumes and build cache, possibly on another volume, 1.4G reclaimable',
      bytes: 3_000_000_000,
      command: 'docker system prune',
    });
    dockerOutput = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect((await unmanagedUsage(levelRun({}), false))?.slow).toEqual(['Docker (docker system df)']);
  },
);

test.skipIf(process.platform === 'win32')(
  'a docker call that never returns ends at its cap and stays the pending read',
  async () => {
    docker = '/usr/bin/docker';
    dockerOutput = 'hang';
    mkdirSync(join(home, 'later'));
    try {
      const pending = unmanagedUsage(levelRun({}), false);
      await vi.waitFor(() => expect(calls.some(([file]) => file === 'docker')).toBe(true));
      await vi.advanceTimersByTimeAsync(6_000);
      const usage = await pending;

      expect(usage?.slow).toEqual(['Docker (docker system df)']);
      expect(hungRead()).toBe('Docker (docker system df)');
      expect(calls.filter(([file, ...args]) => backgroundWalk(file ?? '', args))).toEqual([]);
    } finally {
      releaseDocker();
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);

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

test.skipIf(process.platform === 'win32')(
  'a dry run that would free a lot still lists the disk as it is now',
  async () => {
    mkdirSync(join(home, 'big'));

    const usage = await unmanagedUsage(levelRun({}, Number.MAX_SAFE_INTEGER), false);

    expect(usage?.entries).toContainEqual({ label: join(home, 'big'), bytes: 4_294_967_296 });
    expect(usage ? formatUnmanagedUsage(usage) : []).toContain(
      '  This is the disk as it is now, before the deletions this dry run lists.',
    );
  },
);

test.skipIf(process.platform === 'win32')('stops listing a folder once the time budget is spent', async () => {
  for (let index = 0; index < 10; index += 1) mkdirSync(join(home, `dir-${index}`));
  const started = Date.now();
  hooks.lstat = (path) => {
    if (path.startsWith(home)) vi.setSystemTime(Date.now() + 2000);
  };

  const usage = await unmanagedUsage(levelRun({}), false);

  expect(Date.now() - started).toBeLessThanOrEqual(17_000);
  expect(usage?.unreached).toBe(10);
  expect(calls.filter(([file, ...args]) => backgroundWalk(file ?? '', args))).toEqual([]);
});

test.skipIf(process.platform === 'win32')('a cancelled gc stops the listing', async () => {
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
  expect(calls.filter(([file, ...args]) => backgroundWalk(file ?? '', args))).toEqual([]);
});

test.skipIf(process.platform === 'win32')(
  'leaves out a cache Stim measured, and marks one it sweeps without measuring',
  async () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const jest = join(temp, `jest_${uid.toString(36)}`);
    const metro = join(temp, 'metro-file-map-abc123');
    mkdirSync(join(jest, 'haste-map-abc123-app'), { recursive: true });
    writeFileSync(metro, 'map');
    mkdirSync(join(temp, 'scratch'));
    const caches = (await discoverCachesAsync()).filter((cache) => cache.prune === 'entries');
    const paths = [...caches.map((cache) => cache.dir), ...caches.flatMap((cache) => cache.files ?? [])];
    const ours = (usage: Awaited<ReturnType<typeof unmanagedUsage>>) =>
      usage?.entries
        .filter((entry) => entry.label.startsWith(temp))
        .map((entry) => ({ label: entry.label, swept: entry.swept }));

    const swept = await unmanagedUsage(levelRun({}, 0, [], paths), false);
    expect(ours(swept)).toEqual(
      expect.arrayContaining([
        { label: jest, swept: true },
        { label: metro, swept: true },
        { label: join(temp, 'scratch') },
      ]),
    );
    expect(ours(swept)).toHaveLength(3);
    expect(swept ? formatUnmanagedUsage(swept) : []).toContainEqual(
      expect.stringMatching(new RegExp(`  \\S+  ${jest}, Stim sweeps only its unused entries$`)),
    );

    const measured = await unmanagedUsage(levelRun({}, 0, paths), false);
    expect(ours(measured)).toEqual([{ label: join(temp, 'scratch') }]);
  },
);

describe.skipIf(process.platform === 'win32')('a walk whose timeout cleanup outlasts its grace', () => {
  const refusal = Object.assign(new Error('Report child 42 did not close within the cleanup budget.'), {
    reportCleanup: true,
  });
  test.each([
    [
      'is slow once the cleanup ends',
      Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      (): unknown => expect.objectContaining({ slow: [join(home, 'a-walk')] }),
    ],
    ['rejects with the cleanup refusal', refusal, (): unknown => refusal],
  ])('%s', async (_case, failure, expected) => {
    mkdirSync(join(home, 'a-walk'));
    let arrive = () => {};
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    hooks.du = (dir) => {
      if (!dir.endsWith('a-walk')) return null;
      arrive();
      return new Promise<string>((_, reject) => {
        setTimeout(() => reject(failure), 5_000 + 3_000);
      });
    };
    const outcome = unmanagedUsage(levelRun({}), false, testContext()).then(
      (usage) => usage,
      (error: unknown) => error,
    );
    await reached;
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await outcome;

    expect(result).toEqual(expected());
    expect(hungRead()).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('a gc cancelled during a walk', () => {
  test.each([
    ['the cancellation', null],
    [
      'a cleanup refusal',
      Object.assign(new Error('Cannot verify cleanup for report child 42'), { reportCleanup: true }),
    ],
  ])('a cancelled gc waits for its walk to be killed and cleaned up, then rejects with %s', async (_case, refusal) => {
    mkdirSync(join(home, 'a-walk'));
    const controller = new AbortController();
    const steps: string[] = [];
    let arrive = () => {};
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    hooks.du = (dir, signal) => {
      if (!dir.endsWith('a-walk')) return null;
      arrive();
      return new Promise<string>((_, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            steps.push('killed');
            setImmediate(() => {
              steps.push('cleaned up');
              reject(refusal ?? signal.reason);
            });
          },
          { once: true },
        );
      });
    };
    const outcome = unmanagedUsage(levelRun({}), false, testContext({ signal: controller.signal })).then(
      () => null,
      (error: unknown) => {
        steps.push('scan returned');
        return error;
      },
    );
    await reached;
    controller.abort();
    const error = await outcome;

    expect(steps).toEqual(['killed', 'cleaned up', 'scan returned']);
    expect(error).toBe(refusal ?? controller.signal.reason);
    expect(hungRead()).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('a path Stim manages that does not resolve in time', () => {
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
    expect(calls.filter(([file, ...args]) => backgroundWalk(file ?? '', args))).toEqual([]);
  });

  test('stops at once when gc is cancelled, and records the read it left pending', async () => {
    const controller = new AbortController();
    const pending = unmanagedUsage(levelRun({}), false, testContext({ signal: controller.signal }));
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await reached;
    controller.abort();
    expect(await outcome).toMatch(/abort/i);
    expect(hungRead()).toBe(home);
    expect(calls.filter(([file, ...args]) => backgroundWalk(file ?? '', args))).toEqual([]);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(hungRead()).toBeNull();
  });
});

test.skipIf(process.platform === 'win32')(
  'lists a home folder named like a Stim temp leftover, and skips that name only in the temp folder',
  async () => {
    mkdirSync(join(home, 'stim-demo'));
    mkdirSync(join(temp, 'stim-ws-1'));

    const labels = (await unmanagedUsage(levelRun({}), false))?.entries.map((entry) => entry.label) ?? [];

    expect(labels).toContain(join(home, 'stim-demo'));
    expect(labels).not.toContain(join(temp, 'stim-ws-1'));
  },
);

test.skipIf(process.platform === 'win32')(
  'on macOS names the home folders macOS protects and never reads them',
  async () => {
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
  },
);

test.skipIf(process.platform === 'win32')(
  'a walk the deadline cut short counts as not reached, not as slow',
  async () => {
    for (const dir of ['a-first', 'b-second']) mkdirSync(join(home, dir));
    hooks.du = (dir) => {
      if (dir.endsWith('a-first')) vi.setSystemTime(Date.now() + 12_000);
      else if (dir.endsWith('b-second'))
        return Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
      return null;
    };

    const usage = await unmanagedUsage(levelRun({}), false);

    expect(usage?.slow).toEqual([]);
    expect(usage?.unreached).toBe(1);
  },
);

test.skipIf(process.platform === 'win32')(
  'a walk that never closes ends at its cap, stays the pending read, and leaves the rest unreached',
  async () => {
    for (const dir of ['a-stuck', 'b-after']) mkdirSync(join(home, dir));
    let arrive = () => {};
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    let release = () => {};
    hooks.du = (dir) => {
      if (!dir.endsWith('a-stuck')) return null;
      arrive();
      return new Promise<string>((resolve) => {
        release = () => resolve(`1\t${dir}\n`);
      });
    };
    try {
      const pending = unmanagedUsage(levelRun({}), false);
      await reached;
      await vi.advanceTimersByTimeAsync(6_000);
      const usage = await pending;

      expect(usage?.slow).toEqual([join(home, 'a-stuck')]);
      expect(usage?.unreached).toBe(1);
      expect(hungRead()).toBe(join(home, 'a-stuck'));
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'lists only volumes the pressure measurement found short, and on macOS the APFS volumes of their container',
  async () => {
    mkdirSync(join(home, 'big'));
    mkdirSync(join(temp, 'scratch'));
    hooks.volume = (path) => (path === temp ? { volume: '/tmp', freeMb: 512, device: 424_242 } : null);

    const labels = (await unmanagedUsage(levelRun({}), false))?.entries.map((entry) => entry.label) ?? [];
    expect(labels).toContain(join(home, 'big'));
    expect(labels).not.toContain(join(temp, 'scratch'));

    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', { value: platform });
    });
    hooks.dev = { disk3s5: statSync(home).dev, disk3s1s1: 424_240, disk3s6: 424_242, disk9s1: 515_151, disk3: 1 };
    const { readVolumeSpaceAsync } =
      await vi.importActual<typeof import('../stimd/passes/budget.ts')>('../stimd/passes/budget.ts');
    const [measured] = await readVolumeSpaceAsync([home]);
    const tempOn = async (device: number) => {
      hooks.volume = (path) =>
        path === temp && measured ? { volume: '/System/Volumes/VM', freeMb: measured.freeMb + 2, device } : null;
      return (await unmanagedUsage(levelRun({}), false))?.entries.map((entry) => entry.label) ?? [];
    };
    expect(await tempOn(424_242)).toContain(join(temp, 'scratch'));
    expect(await tempOn(515_151)).not.toContain(join(temp, 'scratch'));
  },
);

test.skipIf(process.platform !== 'win32')('on Windows the scan does nothing and runs no command', async () => {
  docker = '/usr/bin/docker';
  expect(await unmanagedUsage(levelRun({}), false)).toBeNull();
  expect(calls).toEqual([]);
});
