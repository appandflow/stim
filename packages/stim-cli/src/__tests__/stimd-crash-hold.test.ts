import { describe, expect, it } from 'vitest';
import { autoUpdateOn } from '../stimd/auto-update.ts';
import { crashLoopAction, crashLooping, keptBoots, type Boot } from '../stimd/crash-hold.ts';

const MINUTE = 60_000;
const now = 100 * MINUTE;
const boot = (minutesAgo: number, build = 'b', abnormal = true): Boot => ({
  at: now - minutesAgo * MINUTE,
  build,
  ...(abnormal ? { abnormal: true as const } : {}),
});

describe('crash counter', () => {
  it.each([
    ['three abnormal exits of the build within 10 minutes', [boot(9), boot(5), boot(1)], true],
    ['one of the three exits is older than 10 minutes', [boot(11), boot(5), boot(1)], false],
    [
      'an exit that was not abnormal (SIGTERM, SIGKILL, the switch relaunch) does not count',
      [boot(5), boot(3, 'b', false), boot(1)],
      false,
    ],
    ['abnormal exits of another build do not count against this one', [boot(5, 'a'), boot(3), boot(1)], false],
  ])('%s', (_name, boots, looping) => {
    expect(crashLooping(keptBoots(boots, now), 'b')).toBe(looping);
  });

  it('keeps at most the 20 newest boots, so a long run of clean starts pushes old crashes out', () => {
    const clean = Array.from({ length: 20 }, (_, index) => boot(index * 0.25, 'b', false));
    expect(crashLooping(keptBoots([boot(9.5), boot(9.4), boot(9.3), ...clean], now), 'b')).toBe(false);
    expect(keptBoots([boot(9.5), ...clean], now)).toHaveLength(20);
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
