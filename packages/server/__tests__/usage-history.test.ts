import type { MachineOwner, StatusPayload } from '@stim-cli/core/state';
import { UsageRecorder } from '../src/usage-history.ts';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');

function owner(fields: Partial<MachineOwner> & Pick<MachineOwner, 'kind'>): MachineOwner {
  return {
    name: fields.kind,
    workspace: null,
    id: null,
    owned: true,
    cpuPercent: 0,
    residentMb: 0,
    memoryMb: 0,
    processes: 1,
    ...fields,
  };
}

function payload(owners: MachineOwner[] | null): StatusPayload {
  return {
    environments: [],
    capacity: { liveCount: 0, committedMb: 0, totalMemoryMb: 0, overCapacity: false },
    deviceLeases: [],
    unprovisionedWorktrees: [],
    simctlAvailable: true,
    machine: owners && { memorySource: 'footprint', owners },
  };
}

test('keeps 40 fifteen-second points per environment and device, summing an environment over its owners', () => {
  const recorder = new UsageRecorder();
  recorder.record(
    payload([
      owner({ kind: 'simulator', workspace: '/w/app', id: 'UDID-1', cpuPercent: 12.34, memoryMb: 1500.4 }),
      owner({ kind: 'metro', workspace: '/w/app', id: '8081', cpuPercent: 3, memoryMb: 600 }),
      owner({
        kind: 'emulator',
        workspace: '/w/other',
        slot: 'tablet',
        id: 'stim-other',
        cpuPercent: 50,
        memoryMb: 2400,
      }),
      owner({ kind: 'shared', cpuPercent: 99, memoryMb: 99 }),
    ]),
    T0,
  );
  recorder.record(
    payload([owner({ kind: 'metro', workspace: '/w/app', id: '8081', cpuPercent: 1, memoryMb: 590 })]),
    T0 + 25_000,
  );
  recorder.record(payload(null), T0 + 30_000);

  const history = recorder.history(T0 + 30_000)!;
  expect(history).toMatchObject({ intervalMs: 15_000, endAt: T0 + 30_000 });
  const app = history.environments.find((series) => series.workspace === '/w/app')!;
  expect(app.cpuPercent).toHaveLength(40);
  expect(app.cpuPercent.slice(-3)).toEqual([15.3, 1, null]);
  expect(app.memoryMb.slice(-3)).toEqual([2100, 590, null]);
  expect(
    history.devices.map(({ kind, id, workspace, slot }) => ({ kind, id, workspace, ...(slot ? { slot } : {}) })),
  ).toEqual([
    { kind: 'simulator', id: 'UDID-1', workspace: '/w/app' },
    { kind: 'emulator', id: 'stim-other', workspace: '/w/other', slot: 'tablet' },
  ]);
  expect(history.devices[0]!.cpuPercent.slice(-3)).toEqual([12.3, null, null]);
});

test('drops a series once its last reading is older than 10 minutes', () => {
  const recorder = new UsageRecorder();
  recorder.record(
    payload([owner({ kind: 'simulator', workspace: '/w/app', id: 'U', cpuPercent: 5, memoryMb: 1 })]),
    T0,
  );
  recorder.record(payload([]), T0 + 1000);
  expect(recorder.history(T0 + 590_000)?.devices[0]?.cpuPercent[0]).toBe(5);
  expect(recorder.history(T0 + 600_000)).toBeNull();
});

describe('slots between payloads, as status --watch prints no line while usage stays within a step', () => {
  const metro = (cpuPercent: number) =>
    owner({ kind: 'metro', workspace: '/w/app', id: '8081', cpuPercent, memoryMb: 600 });

  test('repeat the reading of a series that stays in the latest payload, up to now', () => {
    const recorder = new UsageRecorder();
    recorder.record(payload([metro(2)]), T0);
    recorder.record(payload([metro(9)]), T0 + 60_000);
    expect(recorder.history(T0 + 120_000)!.environments[0]!.cpuPercent.slice(-9)).toEqual([2, 2, 2, 2, 9, 9, 9, 9, 9]);
  });

  test('repeat the reading up to the payload that drops the series, then stay empty', () => {
    const recorder = new UsageRecorder();
    recorder.record(payload([metro(2)]), T0);
    recorder.record(payload([]), T0 + 60_000);
    const cpu = recorder.history(T0 + 150_000)!.environments[0]!.cpuPercent;
    expect(cpu.slice(-11)).toEqual([2, 2, 2, 2, null, null, null, null, null, null, null]);
  });

  test('stay empty while a series was absent, even when it returns later', () => {
    const recorder = new UsageRecorder();
    recorder.record(payload([metro(7)]), T0);
    recorder.record(payload([]), T0 + 45_000);
    recorder.record(payload([metro(7)]), T0 + 300_000);
    const cpu = recorder.history(T0 + 300_000)!.environments[0]!.cpuPercent;
    expect(cpu.slice(-21)).toEqual([7, 7, 7, ...Array(17).fill(null), 7]);
  });

  test('keep the reading of a series still in the latest payload after ten minutes without a line', () => {
    const recorder = new UsageRecorder();
    recorder.record(payload([metro(4)]), T0);
    expect(recorder.history(T0 + 20 * 60_000)!.environments[0]!.cpuPercent.every((value) => value === 4)).toBe(true);
  });
});
