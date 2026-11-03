import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStatsReport } from '@stim-cli/core/state';
import { workspaceId } from '@stim-cli/core';
import {
  peekDeviceSlots,
  withDeviceBootAdmission,
  countLiveOwnedDevices,
  countLiveOwnedDevicesByPlatform,
  deviceSlotUsages,
  type DeviceSlotWaitPolicy,
} from '../engine/device-capacity.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import * as client from '../daemon/client.ts';
import { liveWaiters } from '../engine/wait-queue.ts';
import { createRunRecorder, readStats, recordRunStats } from '../engine/stats.ts';
import { makeIosSim, makeConfig, makeAdbDevices } from './_factories.ts';
import { admissionLimits } from '../workspace/config.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-device-queue-')));
  process.env.STIM_HOME = root;
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

  test('a waiter held back only by its own platform cap does not block a waiter of another platform', async () => {
    const head = takeTicket({ platform: 'ios', sequence: 1 });
    try {
      const sources = { ...empty, sims: [sim('a')] };
      await expect(admit('android', { max: 0, platformMax: { ios: 1, android: 1 }, sources })).resolves.toBe('booted');
    } finally {
      releaseClaim(head);
    }
  });
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
  expect(lines[0]).toContain('a device slot (1/1 devices booted, concurrency.maxDevices) held by stim-holder');
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
  expect(lines[0]).toBe(
    'device      waiting for a device slot (2/2 devices booted, concurrency.maxDevices) held by tree-one, tree-two: queue position 1 of 1, 0s elapsed -- stim guide lifecycle concurrency',
  );
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
  'cancellation during %s boots nothing and leaves no ticket',
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

test('automatic device admission rechecks exclusion after waiting and clears its own wait ticket', async () => {
  const boot = vi.fn<() => Promise<string>>(async () => 'booted');
  const sleeping = vi.fn<() => Promise<void>>(async () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ remote: { devicePoolDisabled: ['local'] } }));
  });
  const device = { platform: 'ios', key: 'new' };
  await expect(
    withDeviceBootAdmission(device, boot, {
      root,
      max: 1,
      automatic: true,
      sources: { ...empty, sims: occupied },
      sleep: sleeping,
    }),
  ).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(sleeping).toHaveBeenCalledOnce();
  expect(boot).not.toHaveBeenCalled();
  expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
  await expect(withDeviceBootAdmission(device, boot, { root, max: 0, automatic: true })).rejects.toMatchObject({
    code: 'STIM_HOSTING_REFUSED',
  });
  await expect(withDeviceBootAdmission(device, boot, { root, max: 0 })).resolves.toBe('booted');
});

describe('boot admission beyond the device caps', () => {
  const calm = () => ({ level: 'normal', availableBytes: 8 * 1024 ** 3 });
  const admit = (policy: Partial<Parameters<typeof withDeviceBootAdmission>[2]>) =>
    withDeviceBootAdmission({ platform: 'ios', key: 'new' }, async () => 'booted', {
      root,
      max: 8,
      noWait: true,
      memory: calm,
      sources: empty,
      ...policy,
    });
  const booting = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ platform: 'ios', key: `b${index}`, displayName: `tree-${index}` }));

  test('a freed device slot goes to the queued run, not a newcomer', async () => {
    let full = true;
    const sims = () => (full ? occupied : []);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = withDeviceBootAdmission({ platform: 'ios', key: 'queued' }, async () => 'queued booted', {
      root,
      max: 1,
      memory: calm,
      sources: { ...empty, sims },
      sleep: () => gate,
    });
    await vi.waitFor(() => expect(liveWaiters('boot')).toHaveLength(1));
    full = false;
    await expect(admit({ max: 1, sources: { ...empty, sims } })).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringContaining('its turn in the device queue'),
    });
    release();
    await expect(queued).resolves.toBe('queued booted');
  });

  test('a finished boot tells the stim-daemon, which wakes the next waiter', async () => {
    const released = vi.spyOn(client, 'notifyReleased');
    await withDeviceBootAdmission(
      { platform: 'ios', key: 'next' },
      async () => {
        expect(released).not.toHaveBeenCalled();
      },
      { root, max: 8, noWait: true, memory: calm, sources: empty },
    );
    expect(released).toHaveBeenCalledWith('boot');
  });

  test('a third boot waits while two are in flight, even with device slots free', async () => {
    await expect(admit({ sources: { ...empty, booting: booting(2) } })).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringContaining('a boot slot (2/2 boots in flight) held by tree-0, tree-1'),
    });
    await expect(admit({ sources: { ...empty, booting: booting(1) } })).resolves.toBe('booted');
  });

  test.each([
    { memory: { level: 'critical', availableBytes: 8 * 1024 ** 3 }, admitted: false },
    { memory: { level: 'warning', availableBytes: 1.5 * 1024 ** 3 }, admitted: false },
    { memory: { level: 'warning', availableBytes: 3 * 1024 ** 3 }, admitted: true },
    { memory: null, admitted: true },
  ])(
    'memory $memory.level with $memory.availableBytes bytes available admits: $admitted',
    async ({ memory, admitted }) => {
      const outcome = await admit({ memory: () => memory }).then(
        (value) => value,
        (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`,
      );
      expect(outcome === 'booted').toBe(admitted);
      expect(outcome).toMatch(admitted ? /^booted$/ : /^STIM_AT_CAPACITY: .*memory/);
    },
  );

  const minuteSleep = (clock: { now: number }) => async () => {
    clock.now += 60_000;
  };
  const listingFails = () => {
    throw Object.assign(new Error('simctl list timed out'), { code: 'ETIMEDOUT' });
  };

  test('without --wait a run behind booted devices keeps waiting until the 90-minute ceiling', async () => {
    const clock = { now: Date.now() };
    const started = clock.now;
    await expect(
      admit({
        max: 1,
        noWait: false,
        sources: { ...empty, sims: occupied },
        now: () => clock.now,
        sleep: minuteSleep(clock),
      }),
    ).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringMatching(/queue position 1 of 1.*, the 90-minute ceiling\.$/),
    });
    expect(clock.now - started).toBe(90 * 60_000);
    expect(readClaimSet(join(root, 'device-waits')).live).toEqual([]);
  });

  test('devices that cannot be counted make the run wait, and it refuses with the listing error after 10 minutes', async () => {
    const clock = { now: Date.now() };
    const started = clock.now;
    await expect(
      admit({
        noWait: false,
        sources: { ...empty, sims: listingFails },
        now: () => clock.now,
        sleep: minuteSleep(clock),
      }),
    ).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringMatching(/a device count \(Stim could not count .*simctl list timed out\).*for 10m00s/),
    });
    expect(clock.now - started).toBe(10 * 60_000);
  });

  test('a count that comes back admits the boot, and --no-wait refuses at once on an uncountable count', async () => {
    let failures = 3;
    const clock = { now: Date.now() };
    const sims = () => (failures-- > 0 ? listingFails() : []);
    await expect(
      admit({ noWait: false, sources: { ...empty, sims }, now: () => clock.now, sleep: minuteSleep(clock) }),
    ).resolves.toBe('booted');
    await expect(admit({ sources: { ...empty, sims: listingFails } })).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringContaining('This run would wait for a device count'),
    });
  });

  test('a boot held only by memory keeps waiting past the position ceiling and boots once memory recovers', async () => {
    const clock = { now: Date.now() };
    const started = clock.now;
    const memory = () =>
      clock.now - started < 30 * 60_000 ? { level: 'critical', availableBytes: 8 * 1024 ** 3 } : null;
    await expect(admit({ noWait: false, memory, now: () => clock.now, sleep: minuteSleep(clock) })).resolves.toBe(
      'booted',
    );
    expect(clock.now - started).toBe(30 * 60_000);
  });
});

test.each([
  { cores: 10, gib: 16, builds: 1, devices: 8 },
  { cores: 12, gib: 32, builds: 2, devices: 18 },
  { cores: 4, gib: 8, builds: 1, devices: 2 },
])('derived caps for $cores cores and $gib GB: $builds builds, $devices devices', ({ cores, gib, builds, devices }) => {
  expect(admissionLimits({ env: {}, cores, totalBytes: gib * 1024 ** 3 })).toEqual({
    maxBuilds: builds,
    maxDevices: devices,
    derived: { builds: true, devices: true },
  });
});

test('concurrency settings override the derived caps, and 0 means derived', () => {
  expect(
    admissionLimits({ env: { STIM_MAX_BUILDS: '3', STIM_MAX_DEVICES: '0' }, cores: 10, totalBytes: 16 * 1024 ** 3 }),
  ).toEqual({ maxBuilds: 3, maxDevices: 8, derived: { builds: false, devices: true } });
});
