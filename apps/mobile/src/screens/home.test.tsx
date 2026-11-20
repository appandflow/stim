import 'react-native-unistyles/mocks';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { fireEvent, render } from '@testing-library/react-native';

import '@/design/unistyles';

import type { ConnectionState } from '@/lib/connection';

import { Home } from './home';

interface MockConnection {
  mac: { id: string; name: string };
  state: ConnectionState;
  retrying?: boolean;
  missing: boolean;
  status: null;
  connection: { retryNow: jest.Mock };
}

let mockConnections: MockConnection[] = [];

jest.mock('expo-router', () => {
  const Empty = () => null;
  return {
    Stack: Object.assign(Empty, {
      Screen: Empty,
      Toolbar: Object.assign(Empty, { Button: Empty, Badge: Empty }),
    }),
    useIsFocused: () => true,
    useRouter: () => ({ push: jest.fn() }),
  };
});
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/menu-drawer', () => ({ useMenuDrawer: () => ({ permanent: true, open: () => {} }) }));
jest.mock('@/hooks/inbox', () => ({ useInbox: () => ({ unread: 0 }) }));
jest.mock('@/hooks/welcome', () => ({ useWelcome: () => ({ show: false, dismiss: () => {} }) }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => 0 }));
jest.mock('@/hooks/large-text', () => ({ useLargeText: () => false }));
jest.mock('@/hooks/home-filters', () => ({
  useHomeFilters: () => ({
    filters: jest.requireActual<typeof import('@/lib/home')>('@/lib/home').DEFAULT_FILTERS,
    update: () => {},
    view: 'devices',
  }),
}));
jest.mock('@/hooks/machines', () => ({
  usePairedMacs: () => mockConnections.map((c) => c.mac),
  useMacs: () => ({ macs: mockConnections.map((c) => c.mac), connections: mockConnections }),
  useWorkspaceItems: () => [],
  useWorktreeItems: () => [],
  useArchiveItems: () => ({ items: [], pending: false }),
}));
jest.mock('@/components/mac-chip', () => ({ MacChip: () => null }));
jest.mock('@/components/copy-button', () => ({
  CopyPill: () => null,
  useCopy: () => ({ copied: false, copy: () => {} }),
}));
jest.mock('@/components/device-grid-tile', () => ({ DeviceGridTile: () => null }));
jest.mock('@/components/workspace-row', () => ({ WorkspaceGroupRow: () => null, WorktreeRow: () => null }));
jest.mock('@/screens/mac-list', () => ({ MacList: () => null }));
jest.mock('@/screens/welcome', () => ({ Welcome: () => null }));
jest.mock('@/components/stim-jar', () => ({ StimJar: () => null }));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('@/components/lists', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ScrollView: View,
    FlatList: ({
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      ListHeaderComponent: React.ReactNode;
      ListEmptyComponent: React.ReactNode;
    }) => (
      <View>
        {ListHeaderComponent}
        {ListEmptyComponent}
      </View>
    ),
  };
});

const link = (name: string, state: ConnectionState, retrying?: boolean): MockConnection => ({
  mac: { id: name, name },
  state,
  retrying,
  missing: false,
  status: null,
  connection: { retryNow: jest.fn() },
});

const screen = () =>
  render(
    <I18nProvider i18n={i18n}>
      <Home />
    </I18nProvider>,
  );

beforeEach(() => {
  mockConnections = [];
});

test('shows a spinner during the first attempt to reach a machine', async () => {
  mockConnections = [link('Studio', { kind: 'connecting' })];
  const view = await screen();
  expect(JSON.stringify(view.toJSON())).toContain('"type":"ActivityIndicator"');
  expect(view.queryByText('Cannot Reach Studio')).toBeNull();
});

test('names a machine that failed to connect, says to check Tailscale and retries it now', async () => {
  const studio = link('Studio', { kind: 'waiting', retryInMs: 4000, reason: 'Connection lost.' }, true);
  mockConnections = [studio];
  const view = await screen();
  expect(view.getByText('Cannot Reach Studio')).toBeTruthy();
  expect(view.getByText('Check that Tailscale is on for this phone and the machine.')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Retry'));
  expect(studio.connection.retryNow).toHaveBeenCalledTimes(1);
});

test('keeps the message while a machine that already failed is retrying', async () => {
  mockConnections = [link('Studio', { kind: 'connecting' }, true)];
  const view = await screen();
  expect(view.getByText('Cannot Reach Studio')).toBeTruthy();
  expect(view.getByLabelText('Retry').props.accessibilityState).toMatchObject({ busy: true });
});
