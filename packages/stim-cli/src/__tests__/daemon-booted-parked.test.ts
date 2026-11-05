import type { IosSimRecord } from '../devices/ios.ts';
import type { ParkedSim } from '../devices/sim-pool.ts';
import { bootedParkedDue } from '../daemon/booted-parked.ts';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

function parked(udid: string, bootedUntil?: string): ParkedSim {
  return {
    udid,
    name: `stim-parked (iPhone 17 26.5) ${udid}`,
    deviceTypeIdentifier: 'iphone-17',
    runtimeIdentifier: 'ios-26-5',
    parkedAt: '2026-11-04T11:00:00.000Z',
    simslimManaged: false,
    ...(bootedUntil ? { bootedUntil } : {}),
  };
}

const sim = (udid: string, state: string): IosSimRecord => ({
  udid,
  state,
  name: `stim-parked ${udid}`,
  runtime: 'iOS 26.5',
  deviceTypeIdentifier: 'iphone-17',
  available: true,
});
const LATER = '2026-11-04T12:10:00.000Z';
const EARLIER = '2026-11-04T11:50:00.000Z';

describe('bootedParkedDue', () => {
  const records = [parked('A', LATER), parked('B', EARLIER), parked('C', LATER), parked('D')];
  const sims = [sim('A', 'Booted'), sim('B', 'Booted'), sim('C', 'Shutdown'), sim('D', 'Shutdown')];

  test('takes the simulators whose grace period passed and those no longer booted, and leaves the rest', () => {
    const due = bootedParkedDue({ records, sims, now: NOW, memory: 'normal' });
    expect(due.map(({ record, why }) => [record.udid, why])).toEqual([
      ['B', 'its grace period has passed'],
      ['C', 'it is no longer booted'],
    ]);
  });

  test('takes every simulator that is kept booted under memory pressure, before its grace period passes', () => {
    const due = bootedParkedDue({ records, sims, now: NOW, memory: 'warning' });
    expect(due.map(({ record }) => record.udid)).toEqual(['A', 'B', 'C']);
  });

  test('takes nothing while the simulator list is unavailable', () => {
    expect(bootedParkedDue({ records, sims: null, now: NOW, memory: 'critical' })).toEqual([]);
  });

  test('a forced ladder takes every marked simulator at normal memory', () => {
    expect(
      bootedParkedDue({ records, sims, now: NOW, memory: 'normal', all: true }).map(({ record }) => record.udid),
    ).toEqual(['A', 'B', 'C']);
  });
});
