import { offloadPlacement, pickOffer, type BuildOffer } from '../offload/client.ts';
import { iphoneRuntimes, type IosToolchain, type WorkerToolchain } from '../offload/toolchain.ts';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';

const LOCAL: IosToolchain = {
  stimBuild: 'b1',
  arch: 'arm64',
  xcode: 'Xcode 27.0 / Build version 27A266a',
  simulatorSdk: '27.0',
  cocoapods: '1.16.2',
};

function offer(
  overrides: Omit<Partial<BuildOffer>, 'toolchain'> & { toolchain?: Partial<WorkerToolchain> } = {},
): BuildOffer {
  return {
    capacity: { running: 0, max: 1, diskFreeBytes: 500 * 1024 ** 3, minDiskFreeBytes: 10 * 1024 ** 3 },
    warm: { checkout: false, dependencies: false, build: false },
    ...overrides,
    toolchain: { ...LOCAL, runtimes: [RUNTIME], ...overrides.toolchain },
  };
}

describe('offloadPlacement', () => {
  const base = { mode: 'auto' as const, machines: 1, liveSlots: 0, maxBuilds: 3, unsupported: null };

  it('builds here in auto while a build slot is free, or when this Mac has no build limit', () => {
    expect(offloadPlacement(base)).toEqual({ offload: false, reason: '3 of 3 build slots free here' });
    expect(offloadPlacement({ ...base, liveSlots: 2 })).toMatchObject({ offload: false });
    expect(offloadPlacement({ ...base, liveSlots: 9, maxBuilds: 0 })).toEqual({
      offload: false,
      reason: 'no build limit here',
    });
  });

  it('offloads in auto only when every slot is busy, and in force whenever it can', () => {
    expect(offloadPlacement({ ...base, liveSlots: 3 })).toEqual({
      offload: true,
      reason: 'all 3 build slots here are busy',
    });
    expect(offloadPlacement({ ...base, mode: 'force' })).toMatchObject({ offload: true });
  });

  it('never offloads when off, unpaired, or for a build a machine cannot take', () => {
    expect(offloadPlacement({ ...base, mode: 'off', liveSlots: 3 })).toMatchObject({ offload: false });
    expect(offloadPlacement({ ...base, mode: 'force', machines: 0 })).toMatchObject({ offload: false });
    expect(offloadPlacement({ ...base, mode: 'force', unsupported: 'device builds build here' })).toEqual({
      offload: false,
      reason: 'device builds build here',
    });
  });
});

describe('pickOffer', () => {
  it('refuses any toolchain difference, a missing runtime, a busy machine and a full disk', () => {
    for (const refused of [
      offer({ toolchain: { stimBuild: 'b2' } }),
      offer({ toolchain: { cocoapods: '1.17.0' } }),
      offer({ toolchain: { xcode: 'Xcode 26.4' } }),
      offer({ toolchain: { simulatorSdk: '27.1' } }),
      offer({ toolchain: { arch: 'x64' } }),
      offer({ toolchain: { runtimes: ['com.apple.CoreSimulator.SimRuntime.iOS-26-5'] } }),
      offer({ capacity: { running: 1, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 } }),
      offer({ capacity: { running: 0, max: 1, diskFreeBytes: 1024 ** 3, minDiskFreeBytes: 10 * 1024 ** 3 } }),
    ]) {
      expect(pickOffer([refused], LOCAL, RUNTIME)).toBeNull();
    }
    expect(pickOffer([offer()], { ...LOCAL, stimBuild: null }, RUNTIME)).toBeNull();
  });

  it('prefers the warmest machine, then the least busy', () => {
    const cold = offer();
    const warm = offer({ warm: { checkout: true, dependencies: true, build: false } });
    expect(pickOffer([cold, null, warm], LOCAL, RUNTIME)).toBe(2);
    const busy = offer({ capacity: { running: 1, max: 2, diskFreeBytes: null, minDiskFreeBytes: 0 } });
    expect(pickOffer([busy, cold], LOCAL, RUNTIME)).toBe(1);
  });
});

describe('iphoneRuntimes', () => {
  it('lists only runtimes with an available iPhone simulator', () => {
    expect(
      iphoneRuntimes({
        devices: {
          [RUNTIME]: [{ name: 'iPhone 18 Pro', isAvailable: true }],
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPad Air', isAvailable: true }],
          'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ name: 'iPhone 16', isAvailable: false }],
        },
      }),
    ).toEqual([RUNTIME]);
  });
});
