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

test('a free local slot on a healthy machine stays local instead of consuming a host', () => {
  expect(decide()).toEqual({
    kind: 'local',
    code: 'this-mac-free',
    reason: 'load 1.2/core here, 1 of 3 devices in use',
    skipped: [],
  });
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

test('no configured hosts stays local even when this machine is busy', () => {
  expect(decide(full, [])).toMatchObject({
    kind: 'local',
    reason: expect.stringContaining('no remote machines configured'),
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
])('with local room a busy machine places on the first host under its own load limit: %j', (busy) => {
  const local = { ...here, ...busy };
  const limited = offered('limited', 3, 100, { maxLoadPerCore: 4 });
  expect(decide(local, [offered('equal', 3), offered('over', 4), offered('under', 1.9), limited])).toMatchObject({
    kind: 'host',
    machines: [{ machine: 'under' }, { machine: 'limited' }],
    skipped: [
      { machine: 'equal', code: 'load' },
      { machine: 'over', code: 'load' },
    ],
  });
});

test('ranking prefers the explicit remote machine, then the remote.machines order, not load or free memory', () => {
  const offers = [
    offered('first', 1.5, 100),
    offered('second', 0.1, 200),
    offered('builder', 1.9, 1),
    offered('saturated', 5, 500),
  ];
  const result = decide(full, offers, { buildMachine: 'builder' });
  expect(result.kind === 'host' && result.machines.map((each) => each.machine)).toEqual(['builder', 'first', 'second']);
  expect(result.skipped).toMatchObject([{ machine: 'saturated', code: 'load' }]);
});

test('a host past its own load limit is skipped when this machine is full, and an older host uses this machine limit', () => {
  const result = decide(full, [
    offered('older', 2.5),
    offered('own', 3, 100, { maxLoadPerCore: 4 }),
    offered('idle', 0.2),
  ]);
  expect(result.kind === 'host' && result.machines.map((each) => each.machine)).toEqual(['own', 'idle']);
  expect(result.skipped).toMatchObject([{ machine: 'older', code: 'load', reason: expect.stringContaining('2/core') }]);
});

test('unknown host load is usable only when the local cap or queue cannot take the run', () => {
  expect(decide(full, [offered('unknown', null)])).toMatchObject({ kind: 'host', machines: [{ machine: 'unknown' }] });
  expect(decide({ ...here, loadPerCore: 3 }, [offered('unknown', null)])).toMatchObject({
    kind: 'local',
    skipped: [{ machine: 'unknown', reason: expect.stringContaining('load unknown') }],
  });
  const result = decide(full, [offered('unknown', null), offered('known', 1)]);
  expect(result.kind === 'host' && result.machines.map((each) => each.machine)).toEqual(['unknown', 'known']);
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

test('a placed host and the reasons this machine stays local carry stable codes', () => {
  expect(decide(full).code).toBe('placed');
  expect(decide(full, []).code).toBe('no-remote-mac');
  expect(decide({ ...full, devices: { ...full.devices, count: null } }).code).toBe('device-count-unknown');
  expect(decide({ ...here, loadPerCore: 3 }, [offered('unknown', null)]).skipped[0]?.code).toBe('load');
  expect(decideDevicePlacement({ sticky: { machine: 'mini' } }).code).toBe('sticky');
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

const usable = { usable: true } as const;
const missing = { usable: false, code: 'eas-no-cli', reason: 'eas-cli is not installed' } as const;
const unreachable = { machine: 'mini', failure: 'unreachable' };

test('remote.easFallback takes a full machine to an EAS Simulator only after no Mac admits', () => {
  expect(decide(full, [offered('mini')], { eas: usable })).toMatchObject({ kind: 'host' });
  for (const offers of [[], [unreachable]])
    expect(decide(full, offers, { eas: usable })).toMatchObject({
      kind: 'eas',
      code: 'eas-fallback',
      reason: expect.stringContaining('3 of 3 devices in use'),
    });
  expect(decide({ ...here, devices: { count: 1, max: 3, queued: 2 } }, [], { eas: usable }).kind).toBe('eas');
});

test('an EAS Simulator is never chosen while this machine has room or cannot count its devices', () => {
  for (const local of [
    here,
    { ...here, loadPerCore: 3 },
    { ...here, memoryPressure: 'warning' as const },
    { ...full, devices: { ...full.devices, count: null } },
  ])
    for (const offers of [[], [unreachable]]) expect(decide(local, offers, { eas: usable }).kind).toBe('local');
});

test('a full machine marks the local result so the caller asks EAS, and keeps the wait without it', () => {
  expect(decide(full, [unreachable])).toMatchObject({ kind: 'local', atCapacity: true });
  expect(decide(full, [])).toMatchObject({ kind: 'local', atCapacity: true });
  expect(decide({ ...here, loadPerCore: 3 }, [unreachable])).not.toHaveProperty('atCapacity');
  expect(decide(full, [unreachable], { eas: missing })).toMatchObject({
    kind: 'local',
    code: 'no-host-admits',
    reason: expect.stringContaining('waiting locally'),
    skipped: [
      { machine: 'mini', code: 'unreachable' },
      { machine: 'eas', code: 'eas-no-cli', reason: 'eas-cli is not installed' },
    ],
  });
  expect(decide(full, [], { eas: missing })).toMatchObject({
    kind: 'local',
    code: 'no-remote-mac',
    skipped: [{ machine: 'eas', code: 'eas-no-cli' }],
  });
});

test('an excluded local device never becomes a fallback or triggers EAS without the existing capacity condition', () => {
  const excluded = { ...here, localEnabled: false };
  expect(decide(excluded, [offered('slower', 1.9)])).toMatchObject({ kind: 'host', machines: [{ machine: 'slower' }] });
  expect(decide({ ...excluded, devices: { ...here.devices, count: null } })).toMatchObject({ kind: 'host' });
  expect(decide(excluded, [], { eas: { usable: true } })).toMatchObject({ kind: 'refused' });
  expect(decide({ ...full, localEnabled: false }, [], { eas: { usable: true } })).toMatchObject({ kind: 'eas' });
  expect(
    decide({ ...excluded, devices: { count: 1, max: 0, queued: 1 } }, [], { eas: { usable: true } }),
  ).toMatchObject({ kind: 'eas' });
  expect(
    decide({ ...excluded, devices: { count: null, max: 3, queued: 1 } }, [], { eas: { usable: true } }),
  ).toMatchObject({ kind: 'refused' });
  expect(decide(excluded, [{ machine: 'mini', failure: 'offline' }])).toMatchObject({
    kind: 'refused',
    skipped: [{ machine: 'mini', reason: 'offline' }],
  });
});

describe('remote and remote-only placement', () => {
  const place = (placement: 'auto' | 'remote' | 'remote-only', local = here, offers = [offered('mini')], extra = {}) =>
    decide(local, offers, { placement, ...extra });
  const machines = (result: ReturnType<typeof decide>) =>
    result.kind === 'host' && result.machines.map((e) => e.machine);

  it('remote places on a host although this machine has room, where auto stays local', () => {
    expect(place('auto').kind).toBe('local');
    expect(place('remote')).toMatchObject({
      kind: 'host',
      code: 'placed',
      machines: [{ machine: 'mini', reason: expect.stringContaining('remote tries remote machines first') }],
    });
    expect(place('remote', { ...here, devices: { count: null, max: 3, queued: 0 } }).kind).toBe('host');
  });

  it('remote takes the first host in order under its load limit and the second when the first is loaded or full', () => {
    const full1 = offered('first', 0.3, 100, { available: 0 });
    expect(machines(place('remote', here, [offered('first', 0.3), offered('second', 0.1)]))).toEqual([
      'first',
      'second',
    ]);
    expect(machines(place('remote', here, [offered('first', 2.5), offered('second', 0.1)]))).toEqual(['second']);
    expect(machines(place('remote', here, [full1, offered('second', 0.1)]))).toEqual(['second']);
  });

  it('remote runs here only when no host admits, and never from a host load that is merely higher than this machine', () => {
    expect(place('remote', here, [{ machine: 'mini', failure: 'unreachable' }])).toMatchObject({
      kind: 'local',
      code: 'no-host-admits',
      skipped: [{ machine: 'mini', reason: 'unreachable' }],
    });
    expect(place('remote', { ...here, loadPerCore: 0.1 }, [offered('mini', 1.9)]).kind).toBe('host');
    expect(place('remote', here, []).kind).toBe('local');
  });

  it('remote waits in the local queue when every host is out and this machine is full', () => {
    expect(place('remote', full, [{ machine: 'mini', failure: 'unreachable' }])).toMatchObject({
      kind: 'local',
      atCapacity: true,
      reason: expect.stringContaining('waiting locally'),
    });
  });

  it('remote-only never runs here: it refuses when no host admits and places on one that does', () => {
    expect(machines(place('remote-only', here, [offered('first', 2.5), offered('second', 0.1)]))).toEqual(['second']);
    expect(place('remote-only', here, [{ machine: 'mini', failure: 'unreachable' }])).toMatchObject({
      kind: 'refused',
      code: 'pool-unavailable',
      reason: expect.stringContaining('remote-only never runs here'),
      skipped: [{ machine: 'mini', reason: 'unreachable' }],
    });
    expect(place('remote-only', here, [])).toMatchObject({ kind: 'refused' });
    expect(place('remote-only', here, [offered('mini', 3)])).toMatchObject({ kind: 'refused' });
  });

  it('remote-only tells a host that is only full or loaded, which is worth waiting for, from one that is out', () => {
    const occupied = offered('occupied', 0.5, 100, { available: 0, declined: 'reservations are occupied' });
    const strained = offered('strained', 0.5, 100, {
      declined: 'Host memory pressure could not be read; retry shortly.',
      memoryPressure: 'warning',
    });
    const paused = offered('paused', 0.5, 100, { declined: 'Hosted sessions are paused' });
    const down: PlacementProbe = { machine: 'down', failure: 'down' };
    for (const waitable of [
      [offered('mini', 3)],
      [offered('mini', 0.1, 100, { available: 0 })],
      [occupied],
      [strained],
      [down, occupied],
    ])
      expect(place('remote-only', here, waitable)).toMatchObject({ kind: 'refused', hostsFull: true });
    for (const hopeless of [[], [down], [paused], [down, paused]]) {
      expect(place('remote-only', here, hopeless)).toMatchObject({ kind: 'refused' });
      expect(place('remote-only', here, hopeless)).not.toHaveProperty('hostsFull');
    }
    expect(place('remote', here, [offered('mini', 3)])).toMatchObject({ kind: 'local' });
  });

  it('remote-only ignores whether this machine is full, empty or cannot count its devices', () => {
    for (const local of [here, full, { ...here, devices: { count: null, max: 3, queued: 0 } }])
      expect(place('remote-only', local, [offered('mini')])).toMatchObject({ kind: 'host' });
  });

  it('remote admits a host that reports no load, where auto skips it while this machine has room', () => {
    expect(machines(place('remote', here, [offered('unknown', null)]))).toEqual(['unknown']);
    expect(place('auto', { ...here, memoryPressure: 'warning' }, [offered('unknown', null)]).kind).toBe('local');
  });

  it('macOS auto stays here until this machine is busy, then takes the first host in order', () => {
    const mac = (machine: string): PlacementProbe => ({
      machine,
      offer: {
        platform: 'macos',
        choice: { architecture: 'arm64', macosVersion: '27.0' },
        declined: null,
        capacity: { available: null },
        resources: { loadPerCore: 0.4, memoryFreeBytes: 100, memoryPressure: 'normal' },
      },
    });
    const inputs = { platform: 'macos', placement: 'auto', noWait: false } as const;
    const offers = [mac('first'), mac('second')];
    const devices = { count: 0, max: 0, queued: 0 };
    expect(decideDevicePlacement({ ...inputs, offers, here: { ...here, devices } }).kind).toBe('local');
    expect(decideDevicePlacement({ ...inputs, offers, here: { ...here, devices, loadPerCore: 3 } })).toMatchObject({
      kind: 'host',
      machines: [{ machine: 'first' }, { machine: 'second' }],
    });
  });

  it('places a macOS app with the same order, and a macOS offer answers only for macOS', () => {
    const mac = (machine: string, load: number): PlacementProbe => ({
      machine,
      offer: {
        platform: 'macos',
        choice: { architecture: 'arm64', macosVersion: '27.0' },
        declined: null,
        capacity: { available: null },
        resources: { loadPerCore: load, memoryFreeBytes: 100, memoryPressure: 'normal' },
      },
    });
    const local = { ...here, devices: { count: 0, max: 0, queued: 0 } };
    const result = decideDevicePlacement({
      platform: 'macos',
      placement: 'remote-only',
      here: local,
      noWait: false,
      offers: [mac('first', 2.2), mac('second', 0.4), offered('ios-only')],
    });
    expect(result).toMatchObject({ kind: 'host', machines: [{ machine: 'second' }] });
    expect(result.skipped.map((each) => each.machine)).toEqual(['first', 'ios-only']);
  });
});
