import { buildLabel, deviceTileStatusLabels, workspaceStatusLabels } from '@/lib/spoken-status';
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
      'Building iOS \u00B7 phone, install, 2 minutes elapsed',
    );
  });
});

describe('workspaceStatusLabels', () => {
  it('is empty for a workspace with nothing to report', () => {
    expect(workspaceStatusLabels(env(), now)).toEqual([]);
  });

  it('speaks Metro, each running device with its activity, and the error count', () => {
    const labels = workspaceStatusLabels(
      env({
        metro: { port: 8087, running: true, pid: 1 },
        ios: sim({ activity: { state: 'idle', lastActivityAt: ago(22 * 60_000), basis: [] } }),
        android: { name: 'a', serial: 'emulator-5554', owned: true, state: 'detected', physical: false },
        logs: { dir: '/l', errorsSinceMarker: 1 },
      }),
      now,
    );
    expect(labels).toEqual(['Metro running on port 8087', 'iOS, idle for 22 minutes', 'Android', '1 error']);
  });

  it('speaks a running build, remote sessions, an unhealthy supervisor and driven devices', () => {
    const remote = { platform: 'ios' as const, backend: 'eas' as const, sessionId: 's', state: 'claimed' as const };
    const labels = workspaceStatusLabels(
      env({
        build: build(),
        supervisor: { pid: 1, mode: null, startedAt: null, healthy: false },
        ios: sim({
          activity: { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: ago(47 * 60_000) }, basis: [] },
        }),
        remoteDevices: [
          { ...remote, startedAt: null, webPreviewUrl: null },
          { ...remote, sessionId: 't', startedAt: null, webPreviewUrl: null },
        ],
      }),
      now,
    );
    expect(labels).toEqual([
      'Building iOS, install, 2 minutes elapsed, Cache hit, about 3 min left',
      'supervisor unhealthy',
      'iOS, driven by agent-device for 47 minutes',
      '2 EAS sessions',
    ]);
  });

  it('counts warnings, and calls them issues when one is an error', () => {
    expect(workspaceStatusLabels(env({ warnings: ['a', 'b'] }), now)).toEqual(['2 warnings']);
    const issue = (severity: 'error' | 'warning') => ({ severity }) as NonNullable<EnvironmentState['issues']>[number];
    expect(workspaceStatusLabels(env({ warnings: ['a'], issues: [issue('warning'), issue('error')] }), now)).toEqual([
      '1 issue',
    ]);
  });

  it('leaves out devices that are not running', () => {
    expect(workspaceStatusLabels(env({ ios: sim({ state: 'Shutdown' }) }), now)).toEqual([]);
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
});
