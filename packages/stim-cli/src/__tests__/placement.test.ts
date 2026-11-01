import {
  decideDevicePlacement,
  type PlacementHere,
  type PlacementOffer,
  type PlacementProbe,
} from '../device-host/placement.ts';

const here: PlacementHere = {
  loadPerCore: 1.2,
  maxLoadPerCore: 2,
  memoryPressure: 'normal',
  devices: { count: 1, max: 3, queued: 0 },
  budgetRefusal: null,
};
const choice = {
  deviceType: 'iPhone 17 Pro',
  deviceTypeId: 'iphone',
  runtime: '27.0',
  runtimeId: 'ios27',
  architecture: 'arm64' as const,
};
const offered = (
  machine: string,
  load: number | null = 0.5,
  memory = 100,
  host: { maxLoadPerCore?: number; available?: number; declined?: string; memoryPressure?: string } = {},
): PlacementProbe => ({
  machine,
  offer: {
    platform: 'ios',
    choice,
    declined: host.declined ?? null,
    capacity: { available: host.available ?? 1 },
    resources: {
      loadPerCore: load,
      ...(host.maxLoadPerCore ? { maxLoadPerCore: host.maxLoadPerCore } : {}),
      memoryFreeBytes: memory,
      memoryPressure: host.memoryPressure ?? 'normal',
    },
  },
});
const full: PlacementHere = { ...here, devices: { count: 3, max: 3, queued: 0 } };
const decide = (local = here, offers: PlacementProbe[] = [offered('mini')], extra = {}) =>
  decideDevicePlacement({ platform: 'ios', here: local, offers, noWait: false, ...extra });

test('fallback includes every declined, incompatible, full, pressured and unreachable host', () => {
  const base = (offered('base') as { offer: PlacementOffer }).offer;
  const offers: PlacementProbe[] = [
    { machine: 'declined', offer: { ...base, declined: 'All configured hosted device reservations are occupied' } },
    { machine: 'choice', offer: { ...base, choice: null } },
    { machine: 'full', offer: { ...base, capacity: { available: 0 } } },
    { machine: 'pressure', offer: { ...base, resources: { ...base.resources, memoryPressure: 'warning' } } },
    { machine: 'wrong-platform', offer: { ...base, platform: 'android' } },
    { machine: 'offline', failure: 'unreachable' },
  ];
  const result = decide(full, offers);
  expect(result).toMatchObject({
    kind: 'local',
    reason: expect.stringContaining('waiting locally'),
    skipped: offers.map((each) => ({ machine: each.machine, reason: expect.any(String) })),
  });
  expect(result.skipped[0]?.reason).toBe('declined: All configured hosted device reservations are occupied');
  expect(result.skipped.map((each) => each.code)).toEqual([
    'declined',
    'no-matching-device',
    'no-capacity',
    'memory',
    'no-matching-device',
    'unreachable',
  ]);
  expect(result.code).toBe('no-host-admits');
});

describe('remote and remote-only placement', () => {
  const place = (placement: 'auto' | 'remote' | 'remote-only', local = here, offers = [offered('mini')], extra = {}) =>
    decide(local, offers, { placement, ...extra });

  it('remote places on a host although this machine has room, where auto stays local', () => {
    expect(place('auto').kind).toBe('local');
    expect(place('remote')).toMatchObject({
      kind: 'host',
      code: 'placed',
      machines: [{ machine: 'mini', reason: expect.stringContaining('remote tries remote machines first') }],
    });
    expect(place('remote', { ...here, devices: { count: null, max: 3, queued: 0 } }).kind).toBe('host');
  });
});
