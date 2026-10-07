import 'react-native-unistyles/mocks';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { fireEvent, render, within } from '@testing-library/react-native';

import '@/design/unistyles';

import mockCaptured from '../../mock-server/fixtures/status.json';
import mockArchiveDetails from '../../mock-server/fixtures/archive-details.json';
import type { ArchiveDetailResult, EnvironmentState } from '@/protocol/types';
import { RequestError } from '@/lib/connection';
import type { ArchivedWorkspace } from '@/lib/archived';

import { WorkspaceDetail } from './workspace-detail';

let mockEnvironments: EnvironmentState[] = [];
let mockArchives: ArchivedWorkspace[] = mockCaptured.payload.archived as ArchivedWorkspace[];
const mockPush = jest.fn();
let mockDetail: { data: ArchiveDetailResult | null; error: Error | null };
const mockConnection = { request: jest.fn() };
beforeEach(() => {
  mockDetail = { data: mockArchiveDetails['stim--archive-1'] as ArchiveDetailResult, error: null };
  mockConnection.request.mockReset();
  mockArchives = mockCaptured.payload.archived as ArchivedWorkspace[];
});
jest.mock('expo-router', () => {
  const { View, Text } = jest.requireActual('react-native');
  const Toolbar = Object.assign(View, { Menu: View, MenuAction: Text });
  return {
    Stack: { Screen: () => null, Toolbar },
    useRouter: () => ({ push: mockPush }),
    useIsFocused: () => true,
    useNavigation: () => ({ addListener: () => () => {}, canGoBack: () => true }),
  };
});
jest.mock('@/hooks/machines', () => ({
  useMacConnection: () => ({
    mac: { id: 'mac', name: 'Mac' },
    state: { kind: 'open', features: [] },
    home: null,
    connection: mockConnection,
  }),
  useHasStatus: () => true,
  useMachineStatus: () => ({ environments: mockEnvironments, archived: mockArchives }),
  useWorkspace: (_id: string, path: string) => ({
    env: mockEnvironments.find((env) => env.path === path),
    title: 'feat/unified',
    project: 'stim',
    inCheckout: 'apps/mobile',
  }),
}));
jest.mock('@/hooks/archive-detail', () => ({
  useArchiveDetail: () => mockDetail,
}));
jest.mock('@/hooks/app-foreground', () => ({ useAppForeground: () => true }));
jest.mock('@/hooks/build-plans', () => ({ useWorkspaceBuildPlans: () => () => undefined }));
jest.mock('@/hooks/workspace-actions', () => ({ useAction: () => ({ available: null, pending: null }) }));
jest.mock('@/hooks/recents', () => ({ useRecents: () => ({ touch: () => {} }) }));
jest.mock('@/hooks/screen-reader', () => ({ useAnnounce: () => {} }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => Date.parse('2026-10-05T12:00:00Z') }));
jest.mock('@/hooks/frames', () => ({ useFrame: () => ({ frame: null }) }));
jest.mock('@/hooks/device-zoom', () => ({ useZoomedAway: () => false, zoomKey: () => '' }));
jest.mock('@/hooks/workspace-logs', () => ({ useAgentActions: () => [], useBuildOutput: () => [] }));
jest.mock('@/components/lists', () => ({
  ScrollView: jest.requireActual<typeof import('react-native')>('react-native').ScrollView,
}));
jest.mock('@/components/action-toast', () => ({ ActionToast: () => null }));
jest.mock('@/components/connection-banner', () => ({ ConnectionBanner: () => null }));
jest.mock('@/components/header-title', () => ({ HeaderTitle: () => null }));
jest.mock('@/components/read-only', () => ({ readOnlyReason: () => '' }));
jest.mock('@/components/build-progress', () => ({ PhaseBar: () => null }));
jest.mock('@/components/agent-sessions', () => ({ AgentSessionLine: () => null }));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/platform-glyph', () => ({
  PlatformGlyph: ({ platform }: { platform: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{platform}</Text>;
  },
}));

function mobile(folder = 'mobile'): EnvironmentState {
  return {
    path: `/checkout/apps/${folder}`,
    live: true,
    memoryMb: 0,
    warnings: [],
    worktree: { path: '/checkout', branch: 'feat/unified' },
    ios: { udid: folder, name: 'iPhone', state: 'Booted', owned: true },
    android: { serial: 'emulator-1', name: 'Pixel', state: 'detected', owned: true, physical: false },
    lastBuilds: {
      ios: {
        platform: 'ios',
        status: 'ok',
        cacheHit: 'local',
        cacheSkipped: false,
        durationMs: 33000,
        startedAt: '2026-10-05T11:00:00Z',
        finishedAt: '2026-10-05T11:01:02Z',
        fingerprint: 'abc',
      },
      android: {
        platform: 'android',
        status: 'ok',
        cacheHit: false,
        cacheSkipped: false,
        durationMs: 62000,
        startedAt: '2026-10-05T11:00:00Z',
        finishedAt: '2026-10-05T11:01:02Z',
        fingerprint: 'abc',
      },
    },
  };
}
function desktop(): EnvironmentState {
  return {
    path: '/checkout/apps/desktop',
    live: true,
    memoryMb: 0,
    warnings: [],
    worktree: { path: '/checkout', branch: 'feat/unified' },
    macos: {
      launchId: 'desktop',
      arguments: [],
      product: 'Stim',
      bundle: '/Stim.app',
      bundleId: 'com.stim',
      executable: '/Stim',
      state: 'running',
      build: { state: 'ok', startedAt: '2026-10-05T11:00:00Z', durationMs: 4000 },
    },
  };
}
const body = (path = '/checkout/apps/mobile') => (
  <I18nProvider i18n={i18n}>
    <WorkspaceDetail path={path} />
  </I18nProvider>
);

it('keeps a single app Build card and devices free of project text', async () => {
  mockEnvironments = [mobile()];
  const screen = await render(body());
  const build = screen.getByLabelText('Build: iOS last build 0:33, hit, Android last build 1:02, cold');
  expect(within(build).getByText('ios')).toBeTruthy();
  expect(within(build).getByText('android')).toBeTruthy();
  expect(within(build).getByText('0:33 hit')).toBeTruthy();
  expect(within(build).getByText('1:02 cold')).toBeTruthy();
  expect(screen.queryAllByTestId('project-subtitle')).toHaveLength(0);
});

it('unions native and macOS builds into one card without project text', async () => {
  mockEnvironments = [mobile(), desktop()];
  const screen = await render(body());
  const builds = screen.getAllByLabelText(/^Build:/);
  expect(builds).toHaveLength(1);
  for (const platform of ['ios', 'android', 'macos']) expect(within(builds[0]).getByText(platform)).toBeTruthy();
  expect(within(builds[0]).getByText(/^Built /)).toBeTruthy();
  expect(screen.queryAllByTestId('project-subtitle')).toHaveLength(0);
  await fireEvent.press(builds[0]);
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/mac/[id]/build',
    params: { id: 'mac', path: '/checkout/apps/mobile', platform: 'ios' },
  });
});

it('names projects on shared-platform build rows and device tiles', async () => {
  mockEnvironments = [mobile('a'), mobile('b')];
  const screen = await render(body('/checkout/apps/b'));
  const build = screen.getByLabelText(/^Build:/);
  expect(
    within(build)
      .getAllByTestId('project-subtitle')
      .map((node) => node.props.children),
  ).toEqual(['apps/a', 'apps/b', 'apps/a', 'apps/b']);
  expect(screen.getAllByTestId('project-subtitle')).toHaveLength(8);
});

const archivedBody = () => (
  <I18nProvider i18n={i18n}>
    <WorkspaceDetail archive={mockCaptured.payload.archived[0].id} />
  </I18nProvider>
);

it('keeps live-only actions and devices absent from archived workspaces', async () => {
  const screen = await render(archivedBody());
  for (const text of ['Stop', 'Reload', 'Allow control...', 'Devices']) expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByText('#2600 Merged')).toBeTruthy();
  expect(screen.queryByText('Draft')).toBeNull();
});

it('shows no recording when every listed slot has empty spans', async () => {
  mockDetail.data = { builds: {}, recordings: [{ platform: 'ios', slot: 'default', spans: [] }] };
  const screen = await render(archivedBody());
  expect(screen.getByText('No recording available.')).toBeTruthy();
  expect(screen.queryByText('Expired')).toBeNull();
});

it('keeps expired recordings available while the server still lists spans', async () => {
  const archive = mockArchives[0];
  mockArchives = [{ ...archive, expires: { ...archive.expires, recordings: '2026-10-05T11:59:59Z' } }];
  const screen = await render(archivedBody());
  expect(screen.getAllByText('Expired').length).toBeGreaterThan(0);
  expect(screen.getByText('tablet')).toBeTruthy();
});

it('shows default-slot replay on older servers without archive.detail', async () => {
  mockDetail = { data: null, error: new RequestError({ code: 'unknown-method', message: 'Unknown method' }) };
  mockConnection.request.mockImplementation(async (method, target) => {
    if (
      method !== 'replay.range' ||
      target.archive !== mockCaptured.payload.archived[0].id ||
      target.slot !== 'default'
    )
      throw new Error('Unexpected replay target');
    return { spans: [{ start: 100, end: 200 }], markers: [], enabled: true, recording: false };
  });
  const screen = await render(archivedBody());
  expect(await screen.findByText('iOS')).toBeTruthy();
  expect(screen.getByText('Android')).toBeTruthy();
  expect(screen.getByText('Web')).toBeTruthy();
  expect(screen.queryByText(/Update stim-server/)).toBeNull();
});

it('shows no recording when older server default-slot probes all return empty spans', async () => {
  mockDetail = { data: null, error: new RequestError({ code: 'unknown-method', message: 'Unknown method' }) };
  mockConnection.request.mockResolvedValue({ spans: [], markers: [], enabled: false, recording: false });
  const screen = await render(archivedBody());
  expect(await screen.findByText('No recording available.')).toBeTruthy();
});
