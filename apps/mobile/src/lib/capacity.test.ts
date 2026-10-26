import fixture from '../../mock-server/fixtures/status.json';
import added from '../../mock-server/fixtures/capacity.json';

import { deviceHolderRows, loadView, slotMeters } from '@/lib/capacity';
import type { StatusPayload } from '@/protocol/types';

const older = fixture.payload as StatusPayload;
const status = { ...fixture.payload, capacity: { ...fixture.payload.capacity, ...added.capacity } } as StatusPayload;
const capacityOf = (payload: StatusPayload) => {
  if (!payload.capacity) throw new Error('the capture has no capacity');
  return payload.capacity;
};
const capacity = capacityOf(status);
const devices = capacity.devices ?? { max: 0, inUse: 0, holders: [] };
const now = Date.parse(fixture.capturedAt);

describe('loadView', () => {
  it('tones the load by the state Stim reports', () => {
    const load = { cpus: 12, loadPerCore: 2.4, busyAt: 2, limit: null };
    expect(loadView({ ...load, state: 'free' })).toMatchObject({
      value: '2.4 per core',
      state: 'Free',
      tone: 'default',
    });
    expect(loadView({ ...load, state: 'busy' })).toMatchObject({ state: 'Busy', tone: 'warning' });
    expect(loadView({ ...load, state: 'holding' })).toMatchObject({ tone: 'error' });
  });

  it('reads a whole-number load per core', () => {
    expect(loadView({ cpus: 8, loadPerCore: 4, busyAt: 2, limit: null, state: 'busy' }).value).toBe('4 per core');
  });
});

describe('slotMeters', () => {
  it('shows a meter only for a cap that is set, full when every slot is held', () => {
    expect(slotMeters(capacityOf(older))).toEqual([]);
    expect(slotMeters(capacity)).toEqual([
      { kind: 'devices', label: 'Devices', value: '6 / 6', full: true, reason: null },
      { kind: 'builds', label: 'Builds', value: '2 / 2', full: true, reason: null },
    ]);
    expect(slotMeters({ ...capacity, devices: { ...devices, inUse: 5 } })[0]).toMatchObject({
      value: '5 / 6',
      full: false,
    });
  });

  it('shows an uncountable device total as a question mark with the reason', () => {
    const meters = slotMeters({
      ...capacity,
      devices: { max: 4, inUse: null, unknown: 'simctl did not answer', holders: [] },
    });
    expect(meters[0]).toEqual({
      kind: 'devices',
      label: 'Devices',
      value: '? / 4',
      full: false,
      reason: 'simctl did not answer',
    });
  });
});

describe('deviceHolderRows', () => {
  it('names the slot and the idle time of the device the workspace records, and flags an unrecorded device', () => {
    const rows = deviceHolderRows(capacity, status, now);
    expect(rows).toHaveLength(6);
    expect(rows[2]).toMatchObject({ platform: 'ios', title: 'wide-insets' });
    expect(rows[2]?.subtitle).toMatch(/^duo \u00B7 Idle /);
    expect(rows[5]).toMatchObject({
      title: 'stim-old-checkout (iPhone 17 27.0)',
      subtitle: 'Not recorded by a workspace',
    });
  });

  it('shows a booting device as booting', () => {
    const booting = {
      ...devices,
      holders: devices.holders.slice(0, 1).map((holder) => ({ ...holder, booting: true as const })),
    };
    expect(deviceHolderRows({ ...capacity, devices: booting }, status, now)[0]).toMatchObject({ subtitle: 'Booting' });
  });
});
