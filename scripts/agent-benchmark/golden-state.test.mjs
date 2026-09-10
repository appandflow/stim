import { describe, expect, it } from 'vitest';
import { matchesGoldenPreparation, preparedAndroidEmulator } from './golden-state.mjs';

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
    configuration: '[["disk.dataPartition.size","8589934592"]]',
  };
  const avd = {
    name: record.name,
    config: { 'disk.dataPartition.size': '8589934592' },
    systemImage,
    deviceTypeIdentifier: 'medium_phone',
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
      deviceTypeIdentifier: 'medium_phone',
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
      { avds: [{ ...avd, config: { 'disk.dataPartition.size': '6442450944' } }] },
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
      { ...record, deletionClaim: null },
      { ...record, deletionClaim: { pid: 42 } },
    ]) {
      expect(() =>
        preparedAndroidEmulator({ ...input, config: { ...input.config, parked: { android: [replacement] } } }),
      ).toThrow('identity or creation configuration');
    }
  });

  it('refuses a consistent pool and AVD that Stim cannot adopt with benchmark defaults', () => {
    const replacement = {
      ...record,
      configuration: JSON.stringify([['disk.dataPartition.size', String(10 * 1024 ** 3)]]),
    };
    expect(() =>
      preparedAndroidEmulator({
        ...input,
        config: { ...input.config, parked: { android: [replacement] } },
        avds: [{ ...avd, config: { 'disk.dataPartition.size': String(10 * 1024 ** 3) } }],
      }),
    ).toThrow('identity or creation configuration');
  });
});
