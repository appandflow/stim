import { describe, expect, it } from 'vitest';
import { autoUpdateOn } from '../stimd/auto-update.ts';
import { crashLoop, keptBoots, type Boot } from '@stim-cli/core/state';
import { crashLoopAction } from '../stimd/crash-hold.ts';

const MINUTE = 60_000;
const now = 100 * MINUTE;
const boot = (minutesAgo: number, build = 'b', abnormal = true, home?: string): Boot => ({
  at: now - minutesAgo * MINUTE,
  build,
  pid: 1,
  ...(abnormal ? { abnormal: true as const } : {}),
  ...(home ? { home } : {}),
});

describe('crash counter', () => {
  it.each([
    ['three abnormal exits of the build within 10 minutes', [boot(9), boot(5), boot(1)], true],
    ['one of the three exits is older than 10 minutes', [boot(11), boot(5), boot(1)], false],
    [
      'clean boots between abnormal ones do not erase them',
      [boot(9), boot(8, 'b', false), boot(5), boot(4, 'b', false), boot(1), boot(0.5, 'b', false)],
      true,
    ],
    ['abnormal exits of another build do not count against this one', [boot(5, 'a'), boot(3), boot(1)], false],
  ])('%s', (_name, boots, looping) => {
    expect(crashLoop(keptBoots(boots, now), 'b', now) !== null).toBe(looping);
  });

  it('keeps the newest 20 recent boots, plus the abnormal one they pushed out, and the last 10 abnormal boots of any age', () => {
    const clean = Array.from({ length: 25 }, (_, index) => boot(index * 0.25, 'b', false));
    expect(keptBoots([boot(9.5), ...clean], now)).toHaveLength(21);
    const old = Array.from({ length: 12 }, (_, index) => boot(60 + index));
    expect(keptBoots(old, now)).toHaveLength(10);
  });

  it('holds until the abnormal boot that makes it three leaves the window, and says whether the build is to blame', () => {
    const loop = crashLoop([boot(9), boot(5), boot(4), boot(1)], 'b', now);
    expect(loop).toMatchObject({ count: 4, until: now - 5 * MINUTE + 10 * MINUTE, engineCaused: true });
    const disk = crashLoop([boot(9, 'b', true, 'disk full'), boot(5), boot(1)], 'b', now);
    expect(disk).toMatchObject({ count: 3, engineCaused: false, home: 'disk full' });
  });
});

describe('crash-loop rollback decision', () => {
  const homes = [
    { home: '/h/.stim', schema: 1, by: '1.50.0' },
    { home: '/h/.stim/machine', schema: 1, by: '1.50.0' },
  ];

  it('goes back to previous when it reads every claimed home and the machine root', () => {
    expect(crashLoopAction({ version: '1.51.0', previous: { dir: 'aaaaaaaaaaaa', schema: 1 }, homes })).toEqual({
      rollback: 'aaaaaaaaaaaa',
    });
  });

  it('stops with the schema remedy when the bad build migrated a home past what previous reads', () => {
    const migrated = [...homes, { home: '/w/home', schema: 2, by: '1.51.0' }];
    expect(
      crashLoopAction({ version: '1.51.0', previous: { dir: 'aaaaaaaaaaaa', schema: 1 }, homes: migrated }),
    ).toEqual({
      stop: 'engine 1.51.0 crashes and home /w/home was migrated to schema 2 by it; run stim engine rollback --restore-state or stim engine update',
    });
  });

  it('stops when the engine has no previous build', () => {
    expect(crashLoopAction({ version: '1.51.0', previous: null, homes })).toHaveProperty('stop');
  });
});

describe('engine.autoUpdate', () => {
  it.each([
    ['an engine Stim Desktop installed', 'auto', 'install:desktop', false, true],
    ['an engine a service runs', 'auto', 'install:machine', true, true],
    ['a plain global npm install', 'auto', 'install:machine', false, false],
    ['an engine installed through npx', 'auto', 'install:npx', false, false],
    ['the setting turned on for a plain install', 'on', 'install:machine', false, true],
    ['the setting turned off for a Desktop install', 'off', 'install:desktop', true, false],
  ])('%s', (_name, setting, installedBy, service, on) => {
    expect(autoUpdateOn(setting, installedBy, service)).toBe(on);
  });
});
