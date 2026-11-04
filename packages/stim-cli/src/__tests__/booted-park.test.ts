import { bootedParkDeadline, type BootedParkFacts } from '../devices/booted-park.ts';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const open: BootedParkFacts = {
  graceMinutes: 15,
  memory: 'normal',
  counts: { ios: 2, android: 1 },
  maxDevices: 6,
  platformMax: 0,
  now: NOW,
};

describe('bootedParkDeadline', () => {
  test('keeps the simulator booted for the grace period while memory is normal and a slot is free', () => {
    expect(bootedParkDeadline('ios', open)).toBe('2026-11-04T12:15:00.000Z');
  });

  test.each([
    ['a grace period of 0', { graceMinutes: 0 }],
    ['memory pressure at warning', { memory: 'warning' as const }],
    ['memory pressure at critical', { memory: 'critical' as const }],
    ['unreadable memory pressure', { memory: null }],
    ['devices that cannot be counted', { counts: { unknown: 'simctl timed out' } }],
    ['every device slot taken, this one included', { counts: { ios: 4, android: 2 } }],
    ['the platform cap taken, this one included', { platformMax: 2 }],
  ])('shuts it down for %s', (_name, change) => {
    expect(bootedParkDeadline('ios', { ...open, ...change })).toBeNull();
  });

  test('a platform cap that another platform fills does not hold it back', () => {
    expect(bootedParkDeadline('ios', { ...open, platformMax: 2, counts: { ios: 1, android: 3 } })).not.toBeNull();
  });
});
