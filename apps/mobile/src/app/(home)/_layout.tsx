import { t } from '@lingui/core/macro';
import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { MenuDrawer, useMenuDrawer } from '@/components/menu-drawer';

export default function HomeLayout() {
  return (
    <MenuDrawer>
      <HomeStack />
    </MenuDrawer>
  );
}

function HomeStack() {
  const { theme } = useUnistyles();
  const menu = useMenuDrawer();
  return (
    <Stack
      screenOptions={{
        animation: 'none',
        headerBackVisible: false,
        gestureEnabled: false,
        orientation: Platform.OS === 'ios' && Platform.isPad ? undefined : menu.permanent ? 'default' : 'portrait_up',
        headerTintColor: theme.colors.primary,
        headerTitleStyle: { color: theme.colors.text },
        headerShadowVisible: false,
        headerTransparent: Platform.OS === 'ios',
        headerBlurEffect:
          Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) < 26 ? 'systemMaterial' : undefined,
      }}
    >
      <Stack.Screen name="index" options={{ title: t`Stim` }} />
      <Stack.Screen name="inbox" options={{ title: t`Notifications` }} />
    </Stack>
  );
}
