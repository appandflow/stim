import 'react-native-unistyles/mocks';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text as MockText, Pressable as MockPressable, View as MockView } from 'react-native';

import '@/design/unistyles';
import { ArchivedWorkspace } from './archived-workspace';
import captured from '../../mock-server/fixtures/status.json';
import { RequestError } from '@/lib/connection';
import type { StatusPayload } from '@/protocol/types';

const mockPush = jest.fn();
let mockStatus = captured.payload as StatusPayload;
let mockHasRecording = true;
let mockError: Error | null = null;

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useIsFocused: () => true,
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('@/hooks/machines', () => ({
  useStatus: () => mockStatus,
  useMacConnection: () => ({ mac: { id: 'mac' }, state: { kind: 'open' } }),
}));
jest.mock('@/hooks/app-foreground', () => ({ useAppForeground: () => true }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => Date.parse('2026-09-25T04:23:09.012Z') }));
jest.mock('@/hooks/replay-range', () => ({
  useReplayRangeState: (target: { platform: string }, enabled: boolean) => ({
    error: enabled ? mockError : null,
    data: {
      spans: enabled && mockHasRecording && target.platform === 'ios' ? [{ start: 1, end: 2 }] : [],
      markers: [],
    },
  }),
}));
jest.mock('@/components/list', () => ({
  ListSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <MockView>
      <MockText>{title}</MockText>
      {children}
    </MockView>
  ),
  ListRow: ({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) => (
    <MockPressable onPress={onPress}>
      <MockText>{title}</MockText>
      <MockText>{subtitle}</MockText>
    </MockPressable>
  ),
}));
jest.mock('@/components/text', () => ({ Text: MockText }));
jest.mock('@/components/lists', () => ({ ScrollView: MockView }));
jest.mock('@/components/connection-banner', () => ({ ConnectionBanner: () => null }));
jest.mock('@/components/header-title', () => ({ HeaderTitle: () => null }));
jest.mock('@/components/agent-sessions', () => ({
  AgentSessionRow: ({ agent }: { agent: { title: string } }) => <MockText>{agent.title}</MockText>,
}));
jest.mock('@/components/workspace-cards', () => ({
  BuildCard: ({ onPress }: { onPress: () => void }) => (
    <MockPressable onPress={onPress}>
      <MockText>Build</MockText>
    </MockPressable>
  ),
}));
jest.mock('@/screens/build-details', () => ({ LastBuildDetails: () => null }));
jest.mock('@/components/device-screen', () => ({ DeviceScreen: () => null }));
jest.mock('@/components/replay-bar', () => ({ ReplayBar: () => null }));
jest.mock('@/hooks/device-stream', () => ({ useDeviceStream: () => ({}) }));
jest.mock('@/components/sheet-screen', () => ({
  SheetScreen: ({ children }: { children: ReactNode }) => <MockView>{children}</MockView>,
}));

beforeEach(() => {
  mockPush.mockClear();
  mockStatus = captured.payload as StatusPayload;
  mockError = null;
  mockHasRecording = true;
});

const screen = (archive: string) =>
  render(
    <I18nProvider i18n={i18n}>
      <ArchivedWorkspace archive={archive} />
    </I18nProvider>,
  );

test('opens saved logs and the last build and shows a replay only for a recorded span', async () => {
  const archive = mockStatus.archived![0];
  const view = await screen(archive.id);
  expect(view.getByText('#2600 Merged: Keep removed workspaces')).toBeTruthy();
  expect(view.getByText('Removed 2h ago by worktree removal')).toBeTruthy();
  expect(view.getByText('3 builds')).toBeTruthy();
  expect(view.getByText('12 MB')).toBeTruthy();
  expect(view.getByText('Agents')).toBeTruthy();
  expect(view.getByText('Replay')).toBeTruthy();
  await fireEvent.press(view.getByText('Logs'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/mac/[id]/logs',
    params: { id: 'mac', archive: archive.id, path: archive.projectRoot },
  });
  await fireEvent.press(view.getByText('Build'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/mac/[id]/archived-build',
    params: { id: 'mac', archive: archive.id, path: archive.projectRoot },
  });
  for (const label of ['Delete', 'Stop', 'Reload', 'Devices', 'Diff', 'Work', 'Resources'])
    expect(view.queryByText(label)).toBeNull();
});

test('links a replacement to its live workspace and omits replay when no recordings remain', async () => {
  const archive = mockStatus.archived![2];
  const view = await screen(archive.id);
  expect(view.queryByText('Replay')).toBeNull();
  await fireEvent.press(view.getByText('Replaced by'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/mac/[id]/workspace',
    params: { id: 'mac', path: archive.replacedBy },
  });
});

test('keeps Replay hidden when recorded bytes have no span and explains a legacy refusal', async () => {
  mockHasRecording = false;
  mockError = new RequestError({ code: 'bad-request', message: 'workspace is required' });
  const view = await screen(mockStatus.archived![0].id);
  expect(view.queryByText('Replay')).toBeNull();
  expect(view.getByText('Update stim-server to view archived replay')).toBeTruthy();
});
