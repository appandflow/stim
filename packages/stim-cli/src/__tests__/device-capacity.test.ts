import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStatsReport } from '@stim-cli/core/state';
import { workspaceId } from '@stim-cli/core';
import {
  withDeviceBootAdmission,
  deviceSlotWaitingLine,
  type DeviceSlotWaitPolicy,
} from '../engine/device-capacity.ts';
import { reclaimIdleDevice } from '../devices/queue-reclaim.ts';
import { setProjectSetting, upsertProject } from '../workspace/config.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { createRunRecorder, readStats, recordRunStats } from '../engine/stats.ts';
import { goneClaimOwner, plantClaim, makeIosSim, makeConfig, makeAdbDevices } from './_factories.ts';

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

test('a dead waiter is reaped by process identity and cannot block an available slot', async () => {
  const path = plantClaim(join(root, 'device-waits'), 'shared', goneClaimOwner(), {
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => 'booted', {
      root,
      max: 1,
      sources: empty,
      noWait: true,
    }),
  ).resolves.toBe('booted');
  expect(existsSync(path)).toBe(false);
});

test.each([{ noWait: true }, { waitMs: 0 }])(
  'an immediate run cannot jump a live ticket even with spare capacity: %j',
  async (policy) => {
    const ticket = takeTicket();
    const boot = vi.fn<() => Promise<void>>(async () => {});
    try {
      await expect(
        withDeviceBootAdmission({ platform: 'ios', key: 'new' }, boot, {
          root,
          max: 1,
          sources: empty,
          ...policy,
        }),
      ).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
      expect(boot).not.toHaveBeenCalled();
      expect(readClaimSet(join(root, 'device-waits')).live).toHaveLength(1);
    } finally {
      releaseClaim(ticket);
    }
  },
);

test.each(['ios', 'android'])("the run's own booted or booting %s device bypasses a live queue", async (platform) => {
  const ticket = takeTicket();
  try {
    await expect(
      withDeviceBootAdmission({ platform, key: 'own' }, async () => 'reused', {
        root,
        max: 1,
        sources: { ...empty, sims: occupied, booting: [{ platform, key: 'own' }] },
        sleep: async () => {
          throw new Error('own device must not wait');
        },
      }),
    ).resolves.toBe('reused');
    expect(readClaimSet(join(root, 'device-waits')).live).toHaveLength(1);
  } finally {
    releaseClaim(ticket);
  }
});

test('an already booted owned simulator bypasses a live queue even above the cap', async () => {
  const ticket = takeTicket();
  try {
    await expect(
      withDeviceBootAdmission({ platform: 'ios', key: 'own' }, async () => 'reused', {
        root,
        max: 1,
        sources: { ...empty, sims: [...occupied, makeIosSim({ udid: 'own', name: 'stim-own', state: 'Booted' })] },
        sleep: async () => {
          throw new Error('own device must not wait');
        },
      }),
    ).resolves.toBe('reused');
  } finally {
    releaseClaim(ticket);
  }
});

test('a timed-out wait reports elapsed time and count, records both events, and releases its ticket', async () => {
  let now = Date.now();
  const lines: string[] = [];
  const state = vi.fn<NonNullable<DeviceSlotWaitPolicy['waitingFor']>>();
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 1,
      waitMs: 12_000,
      sources: { ...empty, sims: occupied },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      out: (line) => lines.push(line),
      waitingFor: state,
    }),
  ).rejects.toMatchObject({
    code: 'STIM_AT_CAPACITY',
    message: expect.stringContaining('Waited 12s'),
    remedy: expect.stringMatching(/stim stop.*--wait <seconds>.*concurrency.maxDevices/),
  });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('1/1 in use: stim-holder');
  expect(lines[1]).toContain('10s elapsed');
  expect(state.mock.calls[0]?.[0]).toMatchObject({ kind: 'device-slot', inUse: 1, max: 1 });
  expect(state).toHaveBeenLastCalledWith(null);
  expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
  const report = readStatsReport(null, now).report;
  expect(report.capacityRefusals).toEqual([expect.objectContaining({ workspace: workspaceId(root), max: 1 })]);
  expect(report.capacityWaits).toEqual([expect.objectContaining({ kind: 'device-wait', ms: 12_000 })]);
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

test('an error during a wait releases the ticket and clears visible waiting state', async () => {
  const waitingFor = vi.fn<NonNullable<DeviceSlotWaitPolicy['waitingFor']>>();
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 1,
      sources: { ...empty, sims: occupied },
      waitingFor,
      sleep: async () => {
        throw new Error('interrupted');
      },
    }),
  ).rejects.toThrow('interrupted');
  expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
  expect(waitingFor).toHaveBeenLastCalledWith(null);
  expect(readStats().record?.capacityWaits).toHaveLength(1);
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

test('an error reporting an admitted wait still releases the boot reservation', async () => {
  let full = true;
  await expect(
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
      root,
      max: 1,
      sources: { ...empty, sims: () => (full ? occupied : []) },
      sleep: async () => {
        full = false;
      },
      onWait: () => {
        throw new Error('report failed');
      },
    }),
  ).rejects.toThrow('report failed');
  expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
  expect(readClaimSet(join(root, 'device-boots')).live).toEqual([]);
});

test('a queued run names the stuck head and times out listing devices only every 10 seconds', async () => {
  const head = takeTicket({ sequence: 1, displayName: 'stuck-workspace' });
  let now = Date.now();
  const lines: string[] = [];
  const listDevices = vi.fn<() => typeof occupied>(() => occupied);
  try {
    await expect(
      withDeviceBootAdmission(
        { platform: 'android', key: 'new' },
        async () => {
          throw new Error('the follower must not boot');
        },
        {
          root,
          max: 1,
          waitMs: 12_000,
          sources: { ...empty, sims: listDevices },
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          out: (line) => lines.push(line),
        },
      ),
    ).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringContaining(`queue position 2 behind stuck-workspace; queue: ${join(root, 'device-waits')}`),
    });
    expect(lines[1]).toContain('1/1 in use: stim-holder');
    expect(lines[1]).toContain('queue position 2 behind stuck-workspace');
    expect(lines[1]).toContain(join(root, 'device-waits'));
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(readClaimSet(join(root, 'device-waits')).live.map((holder) => holder.claimId)).toEqual([head.claimId]);
  } finally {
    releaseClaim(head);
  }
});

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

test('the queue head reclaims once per poll, then checks capacity before another reclaim and records the count', async () => {
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

test('the waiting workspace setting overrides the machine default, and explicit zero disables reclaim', async () => {
  upsertProject(root, {});
  setProjectSetting(root, 'devices.reclaimIdleMinutes', 0);
  let clock = Date.now();
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
  expect(readStats().record?.capacityWaits?.[0]).not.toHaveProperty('reclaimed');
});

test('a cap exceeded by two devices reclaims only one on each poll', async () => {
  const sims = [...occupied, makeIosSim({ udid: 'second', name: 'stim-second', state: 'Booted' })];
  const counts: number[] = [];
  const sleeps: number[] = [];
  vi.mocked(reclaimIdleDevice).mockImplementation(async () => {
    sims.pop();
    return 1;
  });
  await withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => {}, {
    root,
    max: 1,
    sources: {
      ...empty,
      sims: () => {
        counts.push(sims.length);
        return [...sims];
      },
    },
    sleep: async () => {
      sleeps.push(vi.mocked(reclaimIdleDevice).mock.calls.length);
    },
  });
  expect(counts).toEqual([2, 1, 0]);
  expect(sleeps).toEqual([1, 2]);
  expect(readStats().record?.capacityWaits?.[0]?.reclaimed).toBe(2);
});
