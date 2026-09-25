import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

import { MenuDrawer } from '@/components/menu-drawer';
import { DevPairing } from '@/hooks/dev-pairing';
import { HomeFiltersProvider } from '@/hooks/home-filters';
import { MacsProvider } from '@/hooks/mac-connection';
import { RecentsProvider } from '@/hooks/recents';
import { useColors } from '@/theme';

export default function RootLayout() {
  const scheme = useColorScheme();
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
      <StatusBar style="auto" />
      <MacsProvider>
        <DevPairing />
        <HomeFiltersProvider>
          <RecentsProvider>
            <MenuDrawer>
              <Stack screenOptions={{ headerTintColor: colors.primary, headerTitleStyle: { color: colors.text } }}>
                <Stack.Screen name="index" options={{ title: 'Stim', headerShadowVisible: false }} />
                <Stack.Screen name="filters" options={sheet([0.6, 1])} />
                <Stack.Screen name="macs" options={{ title: 'Machines', headerLargeTitle: true }} />
                <Stack.Screen name="about" options={sheet([0.5, 1])} />
                <Stack.Screen name="pair" options={{ title: 'Pair a machine', presentation: 'modal' }} />
                <Stack.Screen name="rename" options={{ title: 'Rename machine', presentation: 'modal' }} />
                <Stack.Screen name="mac/[id]/index" options={sheet([0.75, 1])} />
                <Stack.Screen
                  name="mac/[id]/workspace"
                  options={{ title: 'Workspace', headerBackButtonDisplayMode: 'minimal', headerShadowVisible: false }}
                />
                <Stack.Screen name="mac/[id]/logs" options={{ title: 'Logs' }} />
                <Stack.Screen
                  name="mac/[id]/device"
                  options={{ headerShown: false, animation: 'fade_from_bottom', gestureEnabled: false }}
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
