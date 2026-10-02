import 'react-native-unistyles/mocks';

import { fireEvent, render } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';

import '@/design/unistyles';

import { MenuDrawer, useMenuDrawer } from './menu-drawer';

let mockPathname = '/';
let mounts = 0;

jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));
jest.mock('react-native-reserved-regions', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ReservedRegionsProvider: ({ children, ...props }: any) => (
      <View testID="shell" {...props}>
        {children}
      </View>
    ),
    useReservedRegions: () => [],
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaProvider: ({ children }: any) => <View>{children}</View>,
  };
});
jest.mock('@/screens/menu', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Menu: () => <Text>menu</Text> };
});
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: jest.requireActual<typeof import('react-native')>('react-native').View },
  interpolate: () => 0,
  useAnimatedStyle: (style: () => unknown) => style(),
  useReducedMotion: () => true,
}));
jest.mock('react-native-drawer-layout', () => {
  const { View, Text, Pressable } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Drawer: ({ children, open, drawerType, onOpen, onClose }: any) => {
      const { useEffect } = jest.requireActual<typeof import('react')>('react');
      useEffect(() => {
        if (open) onOpen();
        else onClose();
      }, [open, drawerType, onOpen, onClose]);
      return (
        <View>
          <Text>{`${drawerType}:${open ? 'open' : 'closed'}`}</Text>
          <Pressable testID="dismiss" onPress={onClose} />
          {children}
        </View>
      );
    },
    useDrawerProgress: () => ({ value: 0 }),
  };
});

function Content() {
  const menu = useMenuDrawer();
  useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <Pressable testID="open" onPress={menu.open}>
      <Text>content</Text>
    </Pressable>
  );
}

beforeEach(() => {
  mockPathname = '/';
  mounts = 0;
});

function layout(screen: Awaited<ReturnType<typeof render>>, width: number, height: number) {
  return fireEvent(screen.getByTestId('shell'), 'layout', { nativeEvent: { layout: { width, height } } });
}

it('keeps a closed compact drawer closed after rotating through a permanent sidebar', async () => {
  const screen = await render(
    <MenuDrawer>
      <Content />
    </MenuDrawer>,
  );
  await layout(screen, 466, 678);
  expect(screen.getByText('back:closed')).toBeTruthy();
  await layout(screen, 951, 669);
  expect(screen.getByText('permanent:open')).toBeTruthy();
  await layout(screen, 466, 678);
  expect(screen.getByText('back:closed')).toBeTruthy();
  expect(mounts).toBe(1);
});

it('restores an open compact drawer after rotating through a permanent sidebar', async () => {
  const screen = await render(
    <MenuDrawer>
      <Content />
    </MenuDrawer>,
  );
  await layout(screen, 466, 678);
  await fireEvent.press(screen.getByTestId('open'));
  expect(screen.getByText('back:open')).toBeTruthy();
  await layout(screen, 951, 669);
  await layout(screen, 466, 678);
  expect(screen.getByText('back:open')).toBeTruthy();
});

it('uses the full screen for a detail route and restores the main sidebar on back', async () => {
  const screen = await render(
    <MenuDrawer>
      <Content />
    </MenuDrawer>,
  );
  await layout(screen, 951, 669);
  expect(screen.getByText('permanent:open')).toBeTruthy();
  mockPathname = '/mac/m1/workspace';
  await screen.rerender(
    <MenuDrawer>
      <Content />
    </MenuDrawer>,
  );
  expect(screen.getByText('back:closed')).toBeTruthy();
  mockPathname = '/';
  await screen.rerender(
    <MenuDrawer>
      <Content />
    </MenuDrawer>,
  );
  expect(screen.getByText('permanent:open')).toBeTruthy();
  expect(mounts).toBe(1);
});
