import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  peekDeviceSlots,
  withDeviceBootAdmission,
  deviceSlotWaitingLine,
  countLiveOwnedDevices,
  countLiveOwnedDevicesByPlatform,
  deviceSlotUsages,
  type DeviceSlotWaitPolicy,
} from '../engine/device-capacity.ts';
import { reclaimIdleDevice } from '../devices/queue-reclaim.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { createRunRecorder, readStats, recordRunStats } from '../engine/stats.ts';
import { makeIosSim, makeConfig, makeAdbDevices } from './_factories.ts';

vi.mock('../devices/queue-reclaim.ts', () => ({
  reclaimIdleDevice: vi.fn<typeof import('../devices/queue-reclaim.ts').reclaimIdleDevice>(async () => 0),
}));

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-device-queue-')));
  process.env.STIM_HOME = root;
  vi.mocked(reclaimIdleDevice).mockReset().mockResolvedValue(0);
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

const empty = { sims: [], adb: makeAdbDevices(), config: makeConfig() };
const occupied = [makeIosSim({ udid: 'holder', name: 'stim-holder', state: 'Booted' })];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('local device counts split by platform and sum to the total, with a booting emulator counted as android', () => {
  const inventory = {
    ...empty,
    sims: [...occupied, makeIosSim({ udid: 'second', name: 'stim-second', state: 'Booting' })],
    booting: [{ platform: 'android', key: 'stim-avd' }],
  };
  expect(countLiveOwnedDevicesByPlatform(inventory)).toEqual({ ios: 2, android: 1 });
  expect(countLiveOwnedDevices(inventory)).toBe(3);
  expect(countLiveOwnedDevicesByPlatform(inventory, { exclude: [{ platform: 'android', key: 'stim-avd' }] })).toEqual({
    ios: 2,
    android: 0,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function takeTicket(details: Record<string, unknown> = {}) {
  const got = tryAcquireClaim({ root: join(root, 'device-waits'), mode: 'shared', label: 'device wait', details });
  if (!got.acquired) throw new Error('ticket not acquired');
  return got.acquired;
}

test.each(['equal timestamps', 'backward clock'])(
  'three device waiters keep FIFO across platforms when later tickets poll first: %s',
  async (clock) => {
    let full = true;
    const admitted: number[] = [];
    const sleepers: (() => void)[][] = [[], [], []];
    const boots = [deferred<void>(), deferred<void>(), deferred<void>()];
    const waiting = [deferred<void>(), deferred<void>(), deferred<void>()];
    const runs: Promise<void>[] = [];
    const listDevices = vi.fn<() => typeof occupied>(() => (full ? occupied : []));
    for (let i = 0; i < 3; i++) {
      runs.push(
        withDeviceBootAdmission(
          { platform: i === 1 ? 'android' : 'ios', key: `device-${i}` },
          async () => {
            admitted.push(i);
            await boots[i]!.promise;
          },
          {
            root,
            max: 1,
            sources: { ...empty, sims: listDevices },
            sleep: () =>
              new Promise<void>((resolve) => {
                sleepers[i]!.push(resolve);
                waiting[i]!.resolve();
              }),
          },
        ),
      );
      await waiting[i]!.promise;
      const holder = readClaimSet(join(root, 'device-waits')).live.find(
        (entry) => entry.details.key === `device-${i}`,
      )!;
      const payload = JSON.parse(readFileSync(holder.path, 'utf8'));
      payload.startedAt =
        clock === 'backward clock' && i === 2 ? '2026-01-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z';
      writeFileSync(holder.path, JSON.stringify(payload));
    }
    const poll = async (i: number) => {
      sleepers[i]!.shift()!();
      await tick();
    };
    expect(readClaimSet(join(root, 'device-waits')).live).toHaveLength(3);
    full = false;
    const listings = listDevices.mock.calls.length;
    await poll(2);
    await poll(1);
    expect(listDevices).toHaveBeenCalledTimes(listings);
    expect(admitted).toEqual([]);
    await poll(0);
    expect(admitted).toEqual([0]);
    expect(listDevices).toHaveBeenCalledTimes(listings + 1);
    expect(readClaimSet(join(root, 'device-boots')).live).toHaveLength(1);
    boots[0]!.resolve();
    await runs[0];
    await poll(2);
    expect(admitted).toEqual([0]);
    await poll(1);
    expect(admitted).toEqual([0, 1]);
    boots[1]!.resolve();
    await runs[1];
    await poll(2);
    boots[2]!.resolve();
    await Promise.all(runs);
    expect(admitted).toEqual([0, 1, 2]);
    expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
    expect(readStats().record?.capacityWaits).toHaveLength(3);
  },
);

describe('per-platform device caps', () => {
  const sim = (udid: string) => makeIosSim({ udid, name: `stim-${udid}`, state: 'Booted' });
  const admit = (platform: string, policy: Partial<Parameters<typeof withDeviceBootAdmission>[2]>) =>
    withDeviceBootAdmission({ platform, key: 'new' }, async () => 'booted', {
      root,
      sources: empty,
      noWait: true,
      ...policy,
    });

  test('queue reclaim for a full platform cap only reclaims devices of that platform', async () => {
    let clock = Date.now();
    await expect(
      admit('ios', {
        max: 0,
        platformMax: { ios: 1 },
        sources: { ...empty, sims: [sim('a')] },
        noWait: false,
        waitMs: 1000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
    expect(reclaimIdleDevice).toHaveBeenCalledWith(
      root,
      expect.any(Number),
      expect.any(Function),
      expect.any(Function),
      expect.any(Set),
      'ios',
    );
  });
});

describe('queue reclaim behind a platform-walled head', () => {
  test('only the first waiter of a platform reclaims, so two runs queued on a full iOS cap do not both shut devices down', async () => {
    const head = takeTicket({ platform: 'ios', sequence: 1 });
    let clock = Date.now();
    try {
      await expect(
        withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
          root,
          max: 0,
          platformMax: { ios: 1 },
          waitMs: 1000,
          sources: { ...empty, sims: [makeIosSim({ udid: 'a', name: 'stim-a', state: 'Booted' })] },
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        }),
      ).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
      expect(reclaimIdleDevice).not.toHaveBeenCalled();
    } finally {
      releaseClaim(head);
    }
  });
});

test('admission records device slot duration in the compiling placement independently of placement timing', async () => {
  let now = Date.now();
  let full = true;
  const stats = createRunRecorder({ platform: 'ios', write: recordRunStats, now: () => now, note: () => {} });
  stats.setProject('fixture');
  stats.setCacheKey('fixture-key');
  await withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
    root,
    max: 1,
    sources: { ...empty, sims: () => (full ? occupied : []) },
    now: () => now,
    sleep: async (ms) => {
      stats.setPlacement({ decision: 'here', reason: 'local compile' });
      now += ms;
      full = false;
    },
    onWait: stats.addDeviceSlotWaitMs,
  });
  stats.record({ failed: false, durationMs: 3000 });
  expect(readStats().record?.placements?.[0]?.deviceSlotWaitMs).toBe(2000);
  expect(readStats().record?.capacityWaits?.[0]?.ms).toBe(2000);
});

test('an unresolved waiter refuses with its exact claim and removal command', async () => {
  const shared = join(root, 'device-waits', 'shared');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'stray'), 'unknown');
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 1,
      sources: empty,
    }),
  ).rejects.toMatchObject({ code: 'STIM_CLAIM_REFUSED', removeCommand: expect.stringContaining(shared) });
});

test('waiting progress names workspaces for live devices and boot claims', async () => {
  let now = Date.now();
  const lines: string[] = [];
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 2,
      waitMs: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      out: (line) => lines.push(line),
      sources: {
        ...empty,
        sims: occupied,
        config: makeConfig({
          projects: {
            '/work/holder-root': { label: 'tree-one', platforms: { ios: { deviceUdid: 'holder', owned: true } } },
          },
        }),
        booting: [{ platform: 'android', key: 'stim-two', displayName: 'tree-two' }],
      },
    }),
  ).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
  const expected =
    'device      waiting for a device slot (2/2 in use: tree-one, tree-two), 0s elapsed -- stim guide lifecycle concurrency';
  expect(lines[0]).toContain(expected);
  expect(lines[0]).toContain(join(root, 'device-waits'));
  expect(deviceSlotWaitingLine({ count: 2, max: 2, holders: ['tree-one', 'tree-two'], elapsedMs: 0 })).toBe(expected);
});

test('cancelling a queued run promptly releases its ticket without booting', async () => {
  const controller = new AbortController();
  const queued = deferred<void>();
  const boot = vi.fn<() => Promise<void>>(async () => {});
  const run = withDeviceBootAdmission({ platform: 'ios', key: 'new' }, boot, {
    root,
    max: 1,
    signal: controller.signal,
    sources: { ...empty, sims: occupied },
    waitingFor: (info) => {
      if (info) queued.resolve();
    },
  });
  const result = run.catch((error) => error);
  await queued.promise;
  controller.abort();
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(boot).not.toHaveBeenCalled();
  expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
});

test.each(['wait notification', 'progress output'])(
  'cancellation during %s starts no idle reclaim',
  async (boundary) => {
    const controller = new AbortController();
    const boot = vi.fn<() => Promise<void>>(async () => {});
    const waitingFor = vi.fn<NonNullable<DeviceSlotWaitPolicy['waitingFor']>>((info) => {
      if (info && boundary === 'wait notification') controller.abort();
    });
    await expect(
      withDeviceBootAdmission({ platform: 'ios', key: 'new' }, boot, {
        root,
        max: 1,
        signal: controller.signal,
        sources: { ...empty, sims: occupied },
        waitingFor,
        out: () => {
          if (boundary === 'progress output') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reclaimIdleDevice).not.toHaveBeenCalled();
    expect(boot).not.toHaveBeenCalled();
    expect(waitingFor).toHaveBeenLastCalledWith(null);
    expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
    expect(readClaimSet(join(root, 'device-boots')).live).toEqual([]);
  },
);

test('a queued run whose own device starts booting is admitted without waiting for its turn', async () => {
  const head = takeTicket({ sequence: 1 });
  let clock = Date.now();
  let ownBooting = false;
  const boot = vi.fn<() => Promise<void>>(async () => {});
  try {
    await withDeviceBootAdmission({ platform: 'ios', key: 'mine' }, boot, {
      root,
      max: 1,
      sources: { ...empty, sims: occupied, booting: () => (ownBooting ? [{ platform: 'ios', key: 'mine' }] : []) },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        ownBooting = true;
      },
    });
    expect(boot).toHaveBeenCalledTimes(1);
  } finally {
    releaseClaim(head);
  }
});

test('the queue head reclaims immediately, then checks capacity before another reclaim and records the count', async () => {
  let full = true;
  let clock = Date.now();
  const order: string[] = [];
  vi.mocked(reclaimIdleDevice).mockImplementation(async () => {
    expect(readClaimSet(join(root, 'device-admission.lock')).live).toEqual([]);
    order.push('reclaim');
    full = false;
    return 1;
  });
  await withDeviceBootAdmission(
    { platform: 'ios', key: 'new' },
    async () => {
      order.push('boot');
    },
    {
      root,
      max: 1,
      sources: {
        ...empty,
        sims: () => {
          order.push('count');
          return full ? occupied : [];
        },
      },
      now: () => clock,
      sleep: async (ms) => {
        order.push('poll');
        clock += ms;
      },
    },
  );
  expect(order).toEqual(['count', 'reclaim', 'poll', 'count', 'boot']);
  expect(reclaimIdleDevice).toHaveBeenCalledTimes(1);
  expect(vi.mocked(reclaimIdleDevice).mock.calls[0]?.[1]).toBe(10 * 60_000);
  expect(readStats().record?.capacityWaits).toMatchObject([{ reclaimed: 1 }]);
});

test('a waiter behind the head does not reclaim even at the cap', async () => {
  const head = takeTicket();
  let clock = Date.now();
  try {
    await expect(
      withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
        root,
        max: 1,
        waitMs: 2000,
        sources: { ...empty, sims: occupied },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
    expect(reclaimIdleDevice).not.toHaveBeenCalled();
  } finally {
    releaseClaim(head);
  }
});

test('a waiter reclaims immediately when it becomes queue head at the cap', async () => {
  const head = takeTicket();
  let clock = 0;
  let full = true;
  const attempts: number[] = [];
  vi.mocked(reclaimIdleDevice).mockImplementation(async () => {
    attempts.push(clock);
    full = false;
    return 1;
  });
  try {
    await withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 1,
      sources: { ...empty, sims: () => (full ? occupied : []) },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock === 4000) releaseClaim(head);
      },
    });
    expect(attempts).toEqual([4000]);
  } finally {
    releaseClaim(head);
  }
});

test('cancelling while the admission lock is held exits without waiting for the holder or booting', async () => {
  const held = tryAcquireClaim({ root: join(root, 'device-admission.lock'), mode: 'exclusive' });
  if (!held.acquired) throw new Error('admission lock not acquired');
  const controller = new AbortController();
  const listDevices = vi.fn<() => typeof occupied>(() => []);
  const boot = vi.fn<() => Promise<void>>(async () => {});
  try {
    const run = withDeviceBootAdmission({ platform: 'ios', key: 'new' }, boot, {
      root,
      max: 1,
      lockWaitMs: 300_000,
      signal: controller.signal,
      sources: { ...empty, sims: listDevices },
    });
    const result = run.catch((error) => error);
    await tick();
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(boot).not.toHaveBeenCalled();
    expect(listDevices).not.toHaveBeenCalled();
    expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
    expect(readClaimSet(join(root, 'device-boots')).live).toEqual([]);
  } finally {
    releaseClaim(held.acquired);
  }
});

test('an explicit zero reclaimIdleMinutes disables reclaim', async () => {
  let clock = Date.now();
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 1,
      reclaimIdleMinutes: 0,
      waitMs: 2000,
      sources: { ...empty, sims: occupied },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
  ).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
  expect(reclaimIdleDevice).not.toHaveBeenCalled();
  expect(readStats().record?.capacityWaits?.[0]).not.toHaveProperty('reclaimed');
});

test('reclaim attempts are at least fifteen seconds apart while capacity is polled', async () => {
  const sims = [...occupied, makeIosSim({ udid: 'second', name: 'stim-second', state: 'Booted' })];
  const attempts: number[] = [];
  let clock = 0;
  let polls = 0;
  vi.mocked(reclaimIdleDevice).mockImplementation(async () => {
    attempts.push(clock);
    if (attempts.length > 1) sims.pop();
    return attempts.length > 1 ? 1 : 0;
  });
  await withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
    root,
    max: 1,
    sources: {
      ...empty,
      sims: () => {
        polls++;
        return [...sims];
      },
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(attempts[0]).toBe(0);
  expect(attempts).toHaveLength(3);
  for (let i = 1; i < attempts.length; i++) {
    expect(attempts[i]! - attempts[i - 1]!).toBeGreaterThanOrEqual(15_000);
  }
  expect(polls).toBeGreaterThan(attempts.length);
  expect(readStats().record?.capacityWaits?.[0]?.reclaimed).toBe(2);
});

test('status reports each per-platform cap that is set, with or without the shared cap, from one inventory', async () => {
  const sources = {
    ...empty,
    sims: [...occupied, makeIosSim({ udid: 'second', name: 'stim-second', state: 'Booted' })],
  };
  expect(await deviceSlotUsages(0, { ios: 2, android: 0 }, sources)).toEqual({
    platformDevices: { ios: { max: 2, inUse: 2 } },
  });
  const both = await deviceSlotUsages(5, { ios: 3, android: 1 }, sources);
  expect(both.devices).toMatchObject({ max: 5, inUse: 2 });
  expect(both.platformDevices).toEqual({ ios: { max: 3, inUse: 2 }, android: { max: 1, inUse: 0 } });
  expect(await deviceSlotUsages(5, {}, sources)).not.toHaveProperty('platformDevices');
  const unknown = await deviceSlotUsages(
    0,
    { android: 1 },
    {
      ...sources,
      sims: () => {
        throw new Error('simctl timed out');
      },
    },
  );
  expect(unknown.platformDevices).toEqual({
    android: { max: 1, inUse: null, unknown: expect.stringContaining('simctl timed out') },
  });
});

test('the placement peek reports the tightest limit and does not queue a run behind a waiter held only by another platform cap', async () => {
  const ticket = takeTicket({ platform: 'ios', sequence: 1 });
  const sources = { ...empty, sims: [makeIosSim({ udid: 'a', name: 'stim-a', state: 'Booted' })] };
  const android = () => peekDeviceSlots({ platform: 'android', project: null, max: 5, platformMax: 1, sources });
  try {
    expect(await android()).toMatchObject({ count: 0, max: 1, queued: 1, limit: 'concurrency.maxAndroidDevices' });
    process.env.STIM_MAX_IOS_DEVICES = '1';
    expect(await android()).toMatchObject({ queued: 0 });
    expect(await peekDeviceSlots({ platform: 'ios', project: null, max: 5, sources })).toMatchObject({
      count: 1,
      max: 1,
      limit: 'concurrency.maxIosDevices',
    });
  } finally {
    delete process.env.STIM_MAX_IOS_DEVICES;
    releaseClaim(ticket);
  }
});
