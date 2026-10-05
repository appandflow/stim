import 'react-native-unistyles/mocks';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { fireEvent, render } from '@testing-library/react-native';

import '@/design/unistyles';

import type { EnvironmentState } from '@/protocol/types';

import { BuildDetails } from './build-details';

let mockEnvironments: EnvironmentState[] = [];
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/hooks/machines', () => ({
  useStatus: () => ({ environments: mockEnvironments }),
  useMacConnection: () => ({ mac: { id: 'mac' }, home: null }),
}));
jest.mock('@/hooks/build-plans', () => ({ useBuildPlan: () => ({ plan: undefined, checkedAt: null, recheck: null }) }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => Date.parse('2026-10-05T12:00:00Z') }));
jest.mock('@/hooks/workspace-logs', () => ({ useBuildOutput: () => [] }));
jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));
jest.mock('react-native-ease', () => ({
  EaseView: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/collapsible', () => ({ Collapsible: () => null, DisclosureChevron: () => null }));
jest.mock('@/components/lists', () => ({
  ScrollView: jest.requireActual<typeof import('react-native')>('react-native').ScrollView,
}));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/platform-glyph', () => ({ PlatformGlyph: () => null }));

function app(folder: string, platform: 'ios' | 'macos'): EnvironmentState {
  const path = `/w/apps/${folder}`;
  const env: EnvironmentState = { path, live: true, memoryMb: 0, warnings: [], worktree: { path: '/w' } };
  if (platform === 'macos')
    env.macos = {
      launchId: 'mac',
      product: 'Stim',
      arguments: [],
      bundle: '/Stim.app',
      executable: '/Stim',
      bundleId: 'com.stim',
      state: 'running',
      build: { state: 'failed', error: 'desktop error', durationMs: 4000, startedAt: '2026-10-05T11:00:00Z' },
    };
  else
    env.lastBuilds = {
      ios: {
        platform: 'ios',
        status: 'failed',
        cacheHit: false,
        cacheSkipped: false,
        startedAt: '2026-10-05T11:00:00Z',
        finishedAt: '2026-10-05T11:00:04Z',
        fingerprint: 'abc',
        durationMs: 4000,
        diagnostics: [{ file: `${path}/main.ts`, line: 1, column: null, message: `${folder} error` }],
      },
    };
  return env;
}
const body = (path: string, platform: 'ios' | 'macos') => (
  <I18nProvider i18n={i18n}>
    <BuildDetails path={path} platform={platform} />
  </I18nProvider>
);

it('switches among the native and macOS builds and opens the selected macOS app logs', async () => {
  mockEnvironments = [app('desktop', 'macos'), app('mobile', 'ios')];
  const screen = await render(body('/w/apps/mobile', 'ios'));
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.queryAllByTestId('project-subtitle')).toHaveLength(0);
  expect(screen.getByText('mobile error')).toBeTruthy();
  await fireEvent.press(screen.getByRole('tab', { name: 'macOS' }));
  expect(screen.getByRole('tab', { name: 'macOS' }).props.accessibilityState.selected).toBe(true);
  expect(screen.getByText('desktop error')).toBeTruthy();
  expect(screen.queryByText('mobile error')).toBeNull();
  await fireEvent.press(screen.getByText('Build logs'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/mac/[id]/logs',
    params: { id: 'mac', path: '/w/apps/desktop', source: 'build' },
  });
});

it('distinguishes shared platforms and shows the selected app diagnostics', async () => {
  mockEnvironments = [app('a', 'ios'), app('b', 'ios')];
  const screen = await render(body('/w/apps/b', 'ios'));
  expect(screen.getByText('b error')).toBeTruthy();
  await fireEvent.press(screen.getByRole('tab', { name: 'iOS, apps/a' }));
  expect(screen.getByText('a error')).toBeTruthy();
  expect(screen.queryByText('b error')).toBeNull();
  expect(screen.getByRole('tab', { name: 'iOS, apps/a' }).props.accessibilityState.selected).toBe(true);
});
