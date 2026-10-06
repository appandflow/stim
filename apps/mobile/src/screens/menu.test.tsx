import 'react-native-unistyles/mocks';

import { fireEvent, render } from '@testing-library/react-native';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';

import '@/design/unistyles';

import { hapticFeedback } from '@/lib/haptics';
import { confirmRestartToUpdate } from '@/hooks/app-update';
import type { updateStatus } from '@/lib/update-status';

import { Menu } from './menu';

let mockPathname = '/';
let mockView = 'workspaces';
let mockUpdateStatus: ReturnType<typeof updateStatus> = null;
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSetView = jest.fn();

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));
jest.mock('@/lib/haptics', () => ({ hapticFeedback: jest.fn() }));
jest.mock('@/hooks/home-filters', () => ({ useHomeFilters: () => ({ view: mockView, setView: mockSetView }) }));
jest.mock('@/hooks/inbox', () => ({ useInbox: () => ({ supported: true, unread: 0 }) }));
jest.mock('@/hooks/machines', () => ({ useMacs: () => ({ connections: [] }) }));
jest.mock('@/hooks/recents', () => ({ useRecents: () => ({ recents: [] }) }));
jest.mock('@/hooks/app-update', () => ({
  useAppUpdate: () => ({ status: mockUpdateStatus }),
  confirmRestartToUpdate: jest.fn(),
}));
jest.mock('@/screens/about', () => ({ About: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
jest.mock('@/components/button', () => ({
  IconButton: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));

beforeEach(() => {
  mockPathname = '/';
  mockView = 'workspaces';
  mockUpdateStatus = null;
  jest.clearAllMocks();
});

it('offers restart only for a ready update and keeps update progress non-interactive', async () => {
  const menu = () => (
    <I18nProvider i18n={i18n}>
      <Menu onClose={jest.fn()} />
    </I18nProvider>
  );
  const screen = await render(menu());
  expect(screen.queryByText('Update ready, tap to restart')).toBeNull();
  expect(screen.queryByText('Checking for updates\u2026')).toBeNull();
  expect(screen.queryByText('Downloading update\u2026')).toBeNull();

  mockUpdateStatus = 'ready';
  await screen.rerender(menu());
  await fireEvent.press(screen.getByRole('button', { name: 'Update ready, tap to restart' }));
  expect(confirmRestartToUpdate).toHaveBeenCalledTimes(1);

  for (const [status, text] of [
    ['checking', 'Checking for updates\u2026'],
    ['downloading', 'Downloading update\u2026'],
  ] as const) {
    mockUpdateStatus = status;
    await screen.rerender(menu());
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: text })).toBeNull();
    expect(screen.queryByText('Update ready, tap to restart')).toBeNull();
  }
});

it('opens Pair above the current content without closing its drawer', async () => {
  const close = jest.fn();
  const screen = await render(<Menu onClose={close} />);
  await fireEvent.press(screen.getByLabelText('Pair a machine'));
  expect(mockPush).toHaveBeenCalledWith('/pair');
  expect(close).not.toHaveBeenCalled();
});

it('replaces primary content and closes the compact drawer without adding a Back destination', async () => {
  const close = jest.fn();
  const screen = await render(<Menu onClose={close} />);
  await fireEvent.press(screen.getByLabelText('Notifications'));
  expect(mockReplace).toHaveBeenCalledWith('/inbox');
  expect(mockPush).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  mockPathname = '/inbox';
  await screen.rerender(<Menu onClose={close} />);
  await fireEvent.press(screen.getByLabelText('Machines'));
  expect(mockSetView).toHaveBeenCalledWith('machines');
  expect(mockReplace).toHaveBeenLastCalledWith('/');
});

it('keeps the current primary route mounted when selecting it again', async () => {
  mockPathname = '/inbox';
  const screen = await render(<Menu onClose={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('Notifications'));
  expect(mockReplace).not.toHaveBeenCalled();
  mockPathname = '/';
  await screen.rerender(<Menu onClose={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('Devices'));
  expect(mockSetView).toHaveBeenCalledWith('devices');
  expect(mockReplace).not.toHaveBeenCalled();
});

it('keeps rendering and reselecting the current primary section silent', async () => {
  const onClose = jest.fn();
  const screen = await render(<Menu onClose={onClose} />);
  expect(hapticFeedback).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Workspaces'));
  expect(hapticFeedback).not.toHaveBeenCalled();
  expect(mockSetView).toHaveBeenCalledWith('workspaces');
  expect(onClose).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Devices'));
  expect(hapticFeedback).toHaveBeenCalledTimes(1);
  expect(hapticFeedback).toHaveBeenLastCalledWith('selection');
  expect(mockSetView).toHaveBeenLastCalledWith('devices');
  mockView = 'devices';
  await screen.rerender(<Menu onClose={onClose} />);
  await fireEvent.press(screen.getByText('Devices'));
  expect(hapticFeedback).toHaveBeenCalledTimes(1);
});

it('marks changing to Notifications but not reselecting it or incoming rerenders', async () => {
  const screen = await render(<Menu onClose={() => {}} />);
  await fireEvent.press(screen.getByText('Notifications'));
  expect(mockReplace).toHaveBeenCalledWith('/inbox');
  expect(hapticFeedback).toHaveBeenCalledTimes(1);
  mockPathname = '/inbox';
  await screen.rerender(<Menu onClose={() => {}} />);
  await fireEvent.press(screen.getByText('Notifications'));
  expect(hapticFeedback).toHaveBeenCalledTimes(1);
});
