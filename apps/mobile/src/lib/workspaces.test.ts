import fixture from '../../mock-server/fixtures/status.json';

import { devicesOf, groupByProject, projectOf, runningBuild, workspaceNames } from '@/lib/workspaces';
import type { EnvironmentState, StatusPayload } from '@/protocol/types';

const payload = fixture.payload as StatusPayload;
const env = (path: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path,
  live: false,
  memoryMb: 0,
  warnings: [],
  ...extra,
});

describe('projectOf', () => {
  it('maps a worktree to the main checkout of the same app', () => {
    expect(projectOf(env('/u/tlon-apps/.worktrees/chat-perf/apps/tlon-mobile'))).toEqual({
      key: '/u/tlon-apps/apps/tlon-mobile',
      name: 'tlon-apps',
    });
    expect(projectOf(env('/u/stim/.claude/worktrees/1123-mobile-app/apps/mobile'))).toEqual({
      key: '/u/stim/apps/mobile',
      name: 'stim',
    });
  });
});

describe('groupByProject', () => {
  it('groups the captured status by project with live projects and workspaces first', () => {
    const groups = groupByProject(payload);
    const tlon = groups.find((g) => g.name === 'tlon-apps');
    expect(tlon?.liveCount).toBe(3);
    expect(tlon?.workspaces.map((w) => workspaceNames(w.path).title).slice(0, 3)).toEqual([
      'chat-perf-demo',
      'wide-insets',
      'wide-split-layout',
    ]);
    const firstIdle = groups.findIndex((g) => g.liveCount === 0);
    expect(groups.slice(firstIdle).every((g) => g.liveCount === 0)).toBe(true);
  });

  it('keeps the main checkout in the group its worktrees join', () => {
    const groups = groupByProject({
      ...payload,
      environments: [env('/u/tlon-apps/apps/tlon-mobile'), env('/u/tlon-apps/.worktrees/a/apps/tlon-mobile')],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('tlon-apps');
  });
});

describe('devicesOf', () => {
  it('lists slot devices and reads the model from the owned simulator name', () => {
    const devices = devicesOf(
      env('/w', {
        ios: { name: 'stim-w (iPhone 18 Pro 27.0)', udid: 'A', owned: true, state: 'Booted' },
        slots: [
          {
            slot: 'ipad',
            ios: { name: 'stim-w-ipad (iPad Pro 11-inch (M5) 27.0)', udid: 'B', owned: true, state: 'Shutdown' },
            android: null,
          },
        ],
      }),
    );
    expect(devices.map((d) => [d.slot, d.model, d.running])).toEqual([
      ['default', 'iPhone 18 Pro 27.0', true],
      ['ipad', 'iPad Pro 11-inch (M5) 27.0', false],
    ]);
  });
});

describe('runningBuild', () => {
  it('attaches a running build only to the device it targets', () => {
    const building = payload.environments.find((e) => e.path.includes('1123-mobile-app'));
    if (!building) throw new Error('fixture lost its building workspace');
    expect(runningBuild(building, { platform: 'ios', slot: 'phone' })?.phase).toBe('install');
    expect(runningBuild(building, { platform: 'ios', slot: 'default' })).toBeNull();
  });
});
