import { describe, expect, it } from 'vitest';
import { assertGoldenCleanup, matchesGoldenPreparation, preparedAndroidEmulator } from './golden-state.mjs';

const expected = {
  locale: 'C.UTF-8',
  fixtureCommit: 'fixture',
  stimVersion: '1.0.0-rc.15',
  stimIntegrity: 'sha512-current',
  stimCliSha256: 'cli-current',
  agentDeviceVersion: '0.20.10',
  agentDeviceSha256: 'agent-device-current',
};

describe('golden preparation provenance', () => {
  it('accepts an exact preparation identity', () => {
    expect(matchesGoldenPreparation(expected, expected)).toBe(true);
  });

  it('rejects missing or mismatched preparation identity', () => {
    expect(matchesGoldenPreparation(null, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, stimVersion: '1.0.0-rc.14' }, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, stimIntegrity: 'sha512-old' }, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, stimCliSha256: 'cli-old' }, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, locale: undefined }, expected)).toBe(false);
    expect(matchesGoldenPreparation({ ...expected, locale: 'en_US.UTF-8' }, expected)).toBe(false);
  });
});

describe('prepared Android pool', () => {
  const systemImage = 'system-images;android-36;google_apis;arm64-v8a';
  const record = {
    udid: 'stim-seed',
    name: 'stim-seed',
    parkedAt: '2026-09-09T00:00:00.000Z',
    systemImage,
    configuration: '[["disk.dataPartition.size","8589934592"],["hw.device.name","pixel_6"],["hw.keyboard","yes"]]',
  };
  const avd = {
    name: record.name,
    config: { 'disk.dataPartition.size': '8589934592', 'hw.device.name': 'pixel_6', 'hw.keyboard': 'yes' },
    systemImage,
    deviceTypeIdentifier: 'pixel_6',
    runtimeIdentifier: 'Android-36',
  };
  const input = {
    config: { pool: { androidParkedMax: 1 }, parked: { android: [record] } },
    avds: [avd],
    activeNames: [],
    systemImage,
    expectedName: record.name,
  };

  it('returns the exact parked device identity for dispatch and collection', () => {
    expect(preparedAndroidEmulator(input)).toEqual({
      ...record,
      deviceTypeIdentifier: 'pixel_6',
      runtimeIdentifier: 'Android-36',
    });
  });

  it('refuses disabled, missing, or ambiguous pools instead of timing a fresh boot', () => {
    for (const config of [
      null,
      {},
      { ...input.config, pool: { androidParkedMax: 0 } },
      { ...input.config, parked: { android: [] } },
      { ...input.config, parked: { android: [record, record] } },
    ]) {
      expect(() => preparedAndroidEmulator({ ...input, config })).toThrow('exactly one parked');
    }
  });

  it('refuses an absent, replaced, incompatible, or still-running AVD', () => {
    for (const override of [
      { avds: [] },
      { expectedName: 'stim-other' },
      { systemImage: 'other-image' },
      { avds: [{ ...avd, systemImage: 'other-image' }] },
      { activeNames: [record.name] },
      { avds: [{ ...avd, config: { ...avd.config, 'disk.dataPartition.size': '6442450944' } }] },
      { avds: [{ ...avd, config: { ...avd.config, 'hw.device.name': 'medium_phone' } }] },
      { avds: [{ ...avd, config: { ...avd.config, 'hw.keyboard': 'no' } }] },
    ]) {
      expect(() => preparedAndroidEmulator({ ...input, ...override })).toThrow(/parked Android emulator/);
    }
  });

  it('refuses unowned names, legacy configuration, and an in-progress deletion', () => {
    for (const replacement of [
      { ...record, name: 'user-device' },
      { ...record, name: 'stim-invalid/name', udid: 'stim-invalid/name' },
      { ...record, udid: 'different' },
      { ...record, parkedAt: undefined },
      { ...record, configuration: undefined },
      { ...record, configuration: '[["disk.dataPartition.size","8589934592"]]' },
      { ...record, deletionClaim: null },
      { ...record, deletionClaim: { pid: 42 } },
    ]) {
      expect(() =>
        preparedAndroidEmulator({ ...input, config: { ...input.config, parked: { android: [replacement] } } }),
      ).toThrow('identity or creation configuration');
    }
  });

  it.each([
    ['disk.dataPartition.size', String(10 * 1024 ** 3)],
    ['hw.device.name', 'medium_phone'],
    ['hw.keyboard', 'no'],
  ])('refuses a consistent pool and AVD with incompatible %s', (key, value) => {
    const config = { ...avd.config, [key]: value };
    const replacement = { ...record, configuration: JSON.stringify(Object.entries(config)) };
    expect(() =>
      preparedAndroidEmulator({
        ...input,
        config: { ...input.config, parked: { android: [replacement] } },
        avds: [{ ...avd, config }],
      }),
    ).toThrow('identity or creation configuration');
  });
});

describe.each(['ios', 'android'])('%s golden cleanup safety', (platform) => {
  const expectedIdentity = platform === 'ios' ? 'GOLDEN-UDID' : 'stim-golden';
  const active = (identity = expectedIdentity) => ({
    owned: true,
    ...(platform === 'ios' ? { deviceUdid: identity } : { avdName: identity }),
  });
  const parked = { udid: expectedIdentity, name: expectedIdentity };
  const verify = (config) => assertGoldenCleanup({ config, platform, expectedIdentity });

  it('permits the sole golden device before adoption, while assigned, and after parking', () => {
    for (const config of [
      { projects: {}, parked: { [platform]: [parked] } },
      { projects: { '/run': { platforms: { [platform]: active() } } } },
      { projects: { '/run': { deviceSlots: { alternate: { [platform]: active() } } } } },
    ])
      expect(() => verify(config)).not.toThrow();
  });

  it('refuses a wrong-device run before parking can evict the golden', () => {
    const config = {
      projects: { '/run': { platforms: { [platform]: active('wrong-device') } } },
      parked: { [platform]: [parked] },
    };
    const original = structuredClone(config);
    expect(() => verify(config)).toThrow('retain worktrees');
    expect(config).toEqual(original);
    expect(() => verify({ ...config, parked: {} })).toThrow('retain worktrees');
  });

  it('refuses missing, duplicate, unowned, deleting, and cross-platform devices', () => {
    for (const config of [
      {},
      { projects: {} },
      { projects: {}, parked: { [platform]: [parked, parked] } },
      { projects: { '/run': { platforms: { [platform]: { ...active(), owned: false } } } } },
      { projects: { '/run': { platforms: { [platform]: active() } } }, parked: { [platform]: [parked] } },
      { projects: {}, parked: { [platform]: [{ ...parked, deletionClaim: { pid: 42 } }] } },
      { projects: { '/run': { platforms: { other: active() } } }, parked: { [platform]: [parked] } },
      {
        projects: { '/run': { deviceSlots: { extra: { [platform]: active('wrong-device') } } } },
        parked: { [platform]: [parked] },
      },
    ])
      expect(() => verify(config)).toThrow('retain worktrees');
    expect(() => assertGoldenCleanup({ config: { projects: {}, parked: { [platform]: [parked] } }, platform })).toThrow(
      'retain worktrees',
    );
  });
});
