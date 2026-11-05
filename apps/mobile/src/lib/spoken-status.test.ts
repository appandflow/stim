import { buildLabel, deviceTileStatusLabels } from '@/lib/spoken-status';
import { devicesOf } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState } from '@/protocol/types';

const now = Date.parse('2026-09-25T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const env = (extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path: '/w',
  live: true,
  memoryMb: 0,
  warnings: [],
  ...extra,
});
const sim = (extra: object = {}) => ({
  name: 'stim-w (iPhone 18 27.0)',
  udid: 'U',
  owned: true,
  state: 'Booted',
  ...extra,
});
const build = (extra: Partial<BuildReport> = {}): BuildReport => ({
  platform: 'ios',
  slot: 'default',
  state: 'running',
  phase: 'install',
  startedAt: ago(178_000),
  phaseStartedAt: ago(30_000),
  outcome: 'hit',
  outcomeKnown: true,
  expectedMs: 300_000,
  expectedPhaseMs: null,
  basis: 4,
  ...extra,
});

describe('buildLabel', () => {
  it('speaks the platform, phase, elapsed time, cache outcome and time left', () => {
    expect(buildLabel(build(), now)).toBe('Building iOS, install, 2 minutes elapsed, Cache hit, about 3 min left');
  });

  it('names a non-default slot and leaves out what a run without history does not know', () => {
    expect(buildLabel(build({ slot: 'phone', outcome: null, expectedMs: null }), now)).toBe(
      'Building iOS, slot phone, install, 2 minutes elapsed',
    );
  });
});

describe('deviceTileStatusLabels', () => {
  it('speaks the activity the tile chip shows, and physical and failed-page badges', () => {
    const [idle] = devicesOf(
      env({ ios: sim({ activity: { state: 'idle', lastActivityAt: ago(22 * 60_000), basis: [] } }) }),
    );
    expect(deviceTileStatusLabels(idle!, now)).toEqual(['idle for 22 minutes']);
    const [recent] = devicesOf(
      env({ ios: sim({ activity: { state: 'idle', lastActivityAt: ago(60_000), basis: [] } }) }),
    );
    expect(deviceTileStatusLabels(recent!, now)).toEqual([]);
    expect(deviceTileStatusLabels({ ...recent!, physical: true, page: { url: 'u', error: 'boom' } }, now)).toEqual([
      'Physical device',
      'Page failed to load',
    ]);
  });

  it('speaks a build running on the device and an app that is not running', () => {
    const running = env({ ios: sim({ app: { id: 'a', state: 'stopped' } }), build: build() });
    const [device] = devicesOf(running);
    expect(deviceTileStatusLabels(device!, now, running)).toEqual([
      'Building iOS, install, 2 minutes elapsed, Cache hit, about 3 min left',
      'app not running',
    ]);
    expect(deviceTileStatusLabels(device!, now)).toEqual(['app not running']);
  });
});
