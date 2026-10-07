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
const offered = (machine: string, load: number | null = 0.5, memory = 100): PlacementProbe => ({
  machine,
  offer: {
    platform: 'ios',
    choice,
    declined: null,
    capacity: { available: 1 },
    resources: { loadPerCore: load, memoryFreeBytes: memory, memoryPressure: 'normal' },
  },
});
const full: PlacementHere = { ...here, devices: { count: 3, max: 3, queued: 0 } };
const decide = (local = here, offers: PlacementProbe[] = [offered('mini')], extra = {}) =>
  decideDevicePlacement({ platform: 'ios', here: local, offers, noWait: false, ...extra });

test('a free local slot on a healthy Mac stays local instead of consuming a host', () => {
  expect(decide()).toEqual({ kind: 'local', reason: 'load 1.2/core here, 1 of 3 devices in use', skipped: [] });
  expect(decide({ ...here, devices: { count: 10, max: 0, queued: 0 } }).kind).toBe('local');
});

test.each([
  full,
  { ...here, devices: { count: 1, max: 3, queued: 2 } },
  { ...here, devices: { count: 1, max: 0, queued: 2 } },
  { ...full, devices: { ...full.devices, queued: 2 } },
])('a full cap or an earlier waiter places on an admitted host: %j', (local) => {
  expect(decide(local)).toMatchObject({ kind: 'host', machines: [{ machine: 'mini' }] });
});

test('no configured hosts stays local even when this Mac is busy', () => {
  expect(decide(full, [])).toMatchObject({
    kind: 'local',
    reason: expect.stringContaining('no remote Macs configured'),
  });
});

test('an unknown inventory stays local for binding admission even under high load', () => {
  expect(decide({ ...full, loadPerCore: 5, devices: { ...full.devices, count: null } })).toMatchObject({
    kind: 'local',
    reason: expect.stringContaining('cannot tell'),
  });
});

test.each([
  { loadPerCore: 3 },
  { memoryPressure: 'warning' as const },
  { budgetRefusal: 'committed memory exceeds budget' },
])('with local room a busy Mac selects only a less loaded host: %j', (busy) => {
  const local = { ...here, ...busy };
  expect(
    decide(local, [
      offered('equal', local.loadPerCore),
      offered('lower', local.loadPerCore - 0.1),
      offered('higher', local.loadPerCore + 1),
    ]),
  ).toMatchObject({
    kind: 'host',
    machines: [{ machine: 'lower' }],
    skipped: [{ machine: 'equal' }, { machine: 'higher' }],
  });
});

test('ranking prefers the explicit remote Mac, then load, free memory and configuration order', () => {
  const offers = [
    offered('first', 1, 200),
    offered('second', 1, 200),
    offered('less-memory', 1, 100),
    offered('lower-load', 0.5, 10),
    offered('builder', 5, 1),
  ];
  const result = decide(full, offers, { buildMachine: 'builder' });
  expect(result.kind === 'host' && result.machines.map((each) => each.machine)).toEqual([
    'builder',
    'lower-load',
    'first',
    'second',
    'less-memory',
  ]);
});

test('unknown host load is usable only when the local cap or queue cannot take the run', () => {
  expect(decide(full, [offered('unknown', null)])).toMatchObject({ kind: 'host', machines: [{ machine: 'unknown' }] });
  expect(decide({ ...here, loadPerCore: 3 }, [offered('unknown', null)])).toMatchObject({
    kind: 'local',
    skipped: [{ machine: 'unknown', reason: expect.stringContaining('load unknown') }],
  });
  const result = decide(full, [offered('unknown', null), offered('known', 10)]);
  expect(result.kind === 'host' && result.machines.map((each) => each.machine)).toEqual(['known', 'unknown']);
});

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
});

test('no-wait does not reject an admitted host or bypass local admission when none admits', () => {
  expect(decide(full, [offered('mini')], { noWait: true }).kind).toBe('host');
  expect(decide(full, [{ machine: 'mini', failure: 'unreachable' }], { noWait: true })).toMatchObject({
    kind: 'local',
    skipped: [{ machine: 'mini', reason: 'unreachable' }],
  });
});

test('Android uses the same admission and ranking with its own image choice', () => {
  const base = (offered('mini') as { offer: PlacementOffer }).offer;
  expect(
    decideDevicePlacement({
      platform: 'android',
      here: full,
      noWait: false,
      offers: [
        {
          machine: 'mini',
          offer: {
            ...base,
            platform: 'android',
            choice: {
              systemImage: 'system-images;android-36;google_apis;arm64-v8a',
              deviceProfile: 'pixel_7',
              architecture: 'arm64-v8a',
            },
          },
        },
      ],
    }),
  ).toMatchObject({ kind: 'host', machines: [{ machine: 'mini' }] });
});
