import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';

import { MenuDrawer } from '@/components/menu-drawer';
import { DevPairing } from '@/hooks/dev-pairing';
import { HomeFiltersProvider } from '@/hooks/home-filters';
import { MacsProvider } from '@/hooks/mac-connection';
import { RecentsProvider } from '@/hooks/recents';
import { SettingsProvider } from '@/hooks/settings';
import { useColors, useEffectiveScheme } from '@/theme';

/** On iPad every screen keeps the orientations the system allows, as iPad multitasking requires. */
function phoneOrientation(orientation: 'portrait_up' | 'default') {
  return Platform.OS === 'ios' && Platform.isPad ? undefined : orientation;
}

export default function RootLayout() {
  return (
    <SettingsProvider>
      <RootLayoutContent />
    </SettingsProvider>
  );
}

function RootLayoutContent() {
  const scheme = useEffectiveScheme();
  const colors = useColors();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.background,
      text: colors.text,
      border: colors.border,
    },
  };
  const sheet = (detents: number[]) =>
    ({
      presentation: 'formSheet',
      headerShown: false,
      sheetGrabberVisible: true,
      sheetAllowedDetents: detents,
      contentStyle: { backgroundColor: colors.background },
    }) as const;
  return (
    <ThemeProvider value={theme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <MacsProvider>
        <DevPairing />
        <HomeFiltersProvider>
          <RecentsProvider>
            <MenuDrawer>
              <Stack
                screenOptions={{
                  orientation: phoneOrientation('portrait_up'),
                  headerTintColor: colors.primary,
                  headerTitleStyle: { color: colors.text },
                  headerBackButtonDisplayMode: 'minimal',
                }}
              >
                <Stack.Screen name="index" options={{ title: 'Stim', headerShadowVisible: false }} />
                <Stack.Screen name="filters" options={sheet([0.6, 1])} />
                <Stack.Screen name="about" options={sheet([0.5, 1])} />
                <Stack.Screen
                  name="settings"
                  options={{
                    title: 'Settings',
                    headerLargeTitle: true,
                    contentStyle: { backgroundColor: colors.grouped },
                    ...(Platform.OS === 'android'
                      ? { headerStyle: { backgroundColor: colors.grouped }, headerShadowVisible: false }
                      : null),
                  }}
                />
                <Stack.Screen name="pair" options={{ title: 'Pair a machine', presentation: 'modal' }} />
                <Stack.Screen name="rename" options={{ title: 'Rename machine', presentation: 'modal' }} />
                <Stack.Screen name="mac/[id]/index" options={sheet([0.75, 1])} />
                <Stack.Screen name="mac/[id]/workspace" options={{ title: 'Workspace', headerShadowVisible: false }} />
                <Stack.Screen name="mac/[id]/logs" options={{ title: 'Logs' }} />
                <Stack.Screen
                  name="mac/[id]/device"
                  options={{
                    headerShown: false,
                    orientation: phoneOrientation('default'),
                    presentation: 'transparentModal',
                    animation: 'none',
                    gestureEnabled: false,
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                />
                <Stack.Screen name="mac/[id]/build-miss" options={sheet([0.5, 1])} />
              </Stack>
            </MenuDrawer>
          </RecentsProvider>
        </HomeFiltersProvider>
      </MacsProvider>
    </ThemeProvider>
  );
}
