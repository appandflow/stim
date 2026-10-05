import 'react-native-unistyles/mocks';
import { receiveStatus } from '../../mock-server/receive-fixtures';
import fixture from '../../mock-server/fixtures/status.json';
import type { StatusPayload } from '@/protocol/types';

import { fireEvent, render } from '@testing-library/react-native';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';

import '@/design/unistyles';

import { RemoteTile } from './remote-tile';
import { AgentIcon } from './agent-icon';
import { PlatformGlyph } from './platform-glyph';
import { MacStatus } from '@/screens/mac-status';

import type { HomeItem } from '@/lib/home';
import { homeSections } from '@/lib/home-list';

import { WorkspaceGroupRow } from './workspace-row';

let mockStatus = receiveStatus(fixture.payload as StatusPayload);
jest.mock('expo-router', () => ({ useIsFocused: () => false, useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/hooks/machines', () => ({
  useMachinePresence: () => ({ online: true, cached: false }),
  useMachineStatus: () => mockStatus,
  useMachineUsage: () => null,
  useMacById: () => ({ mac: { name: 'Mac', endpoint: 'ws://mac' }, state: { kind: 'disconnected' } }),
}));
jest.mock('@/hooks/machine-details', () => ({ useMachineDetails: () => ({ kind: 'unsupported' }) }));
jest.mock('@/hooks/usage-history', () => ({ useUsageHistory: () => [] }));
jest.mock('@/hooks/section-state', () => ({
  useSectionState: () => [{ collapsed: false, showAll: true }, () => {}],
}));
jest.mock('@/components/collapsible', () => ({
  Collapsible: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? children : null),
  DisclosureChevron: () => null,
}));
jest.mock('@/components/sheet-screen', () => ({
  SheetScreen: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/hooks/large-text', () => ({ useLargeText: () => false }));
jest.mock('@/components/build-progress', () => ({ PhaseBar: () => null }));
jest.mock('@/components/agent-sessions', () => ({ AgentSessionLine: () => null }));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: jest.requireActual<typeof import('react-native')>('react-native').View },
  useReducedMotion: () => true,
  FadeInUp: { duration: () => undefined },
  FadeOutUp: { duration: () => undefined },
}));
jest.mock('@/components/icon', () => ({
  Icon: ({ name }: { name: string }) => {
    const { View } = jest.requireActual<typeof import('react-native')>('react-native');
    return <View accessibilityLabel={name} />;
  },
}));

it('shows the branch and git state once while each app opens its original route and errors', async () => {
  const app = (folder: string, live: boolean): HomeItem => ({
    key: `mac\n/checkout/${folder}`,
    macId: 'mac',
    macName: 'MacBook',
    project: 'stim',
    title: 'feat/monorepo',
    inCheckout: folder,
    env: {
      path: `/checkout/${folder}`,
      live,
      phase: 'ready',
      memoryMb: 0,
      warnings: [],
      logs: { dir: '/logs', errorsSinceMarker: live ? 2 : 0 },
      worktree: {
        path: '/checkout',
        branch: 'feat/monorepo',
        git: { changed: 15, untracked: 0, upstream: 'origin/main', ahead: 0, behind: 0, mergedInto: null },
      },
    },
  });
  const mobile = app('apps/mobile', false);
  const desktop = app('apps/desktop', true);
  const workspace = homeSections([mobile, desktop])[0].data[0];
  const open = jest.fn();
  const screen = await render(
    <WorkspaceGroupRow workspace={workspace} now={Date.now()} folder showsMachine onOpen={open} />,
  );
  expect(screen.getAllByText('feat/monorepo')).toHaveLength(1);
  expect(screen.getAllByText('15 changed')).toHaveLength(1);
  expect(screen.getByText('Ready')).toBeTruthy();
  expect(screen.getByText('Running')).toBeTruthy();
  await fireEvent.press(screen.getByText('apps/mobile'));
  expect(open).toHaveBeenLastCalledWith(mobile, false);
  await fireEvent.press(screen.getByText('apps/desktop'));
  expect(open).toHaveBeenLastCalledWith(desktop, false);
  await fireEvent.press(screen.getByText('2 errors'));
  expect(open).toHaveBeenLastCalledWith(desktop, true);
});

test.each(['platform', 'backend', 'state'])(
  'skips unsupported remote %s or shows a neutral claim label',
  async (field) => {
    const session = receiveStatus(fixture.payload as StatusPayload).environments[0]!.remoteDevices![0]!;
    const screen = await render(
      <I18nProvider i18n={i18n}>
        <RemoteTile session={{ ...session, [field]: 'future-kind' }} />
      </I18nProvider>,
    );
    if (field === 'state') expect(screen.getByText(/Claim unknown/)).toBeTruthy();
    else expect(screen.toJSON()).toBeNull();
  },
);

test.each(['future-kind', '__proto__', 'constructor'])(
  'uses generic icons for unsupported %s platforms and tools',
  async (value) => {
    const screen = await render(
      <>
        <PlatformGlyph platform={value} size={16} />
        <AgentIcon tool={value} size={16} color="black" />
      </>,
    );
    expect(screen.getAllByLabelText('gearshape')).toHaveLength(2);
  },
);

test('renders a future machine owner with a generic icon and omits an unknown memory-source explanation', async () => {
  mockStatus = receiveStatus(fixture.payload as StatusPayload);
  mockStatus.machine!.owners[0]!.kind = 'future-kind';
  mockStatus.machine!.owners[0]!.name = 'Future service';
  mockStatus.machine!.memorySource = 'future-kind';
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <MacStatus id="mac" />
    </I18nProvider>,
  );
  expect(screen.getByText('Future service')).toBeTruthy();
  expect(screen.getAllByLabelText('gearshape').length).toBeGreaterThan(0);
  expect(screen.queryByText(/Each process counts in one row/)).toBeNull();
});
