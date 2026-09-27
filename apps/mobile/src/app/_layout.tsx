import * as Sentry from '@sentry/react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { MenuDrawer } from '@/components/menu-drawer';
import { DevPairing } from '@/hooks/dev-pairing';
import { HomeFiltersProvider } from '@/hooks/home-filters';
import { MacsProvider } from '@/hooks/mac-connection';
import { NotificationsProvider } from '@/hooks/notifications';
import { RecentsProvider } from '@/hooks/recents';
import { SettingsProvider } from '@/hooks/settings';

/** On iPad every screen keeps the orientations the system allows, as iPad multitasking requires. */
function phoneOrientation(orientation: 'portrait_up' | 'default') {
  return Platform.OS === 'ios' && Platform.isPad ? undefined : orientation;
}

function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.error}>
      <EmptyState title="Something went wrong" message={error.message}>
        <Button title="Try again" onPress={() => void retry()} />
      </EmptyState>
    </View>
  );
}

export const ErrorBoundary = Sentry.wrapExpoRouterErrorBoundary(RootErrorBoundary);

export default function RootLayout() {
  return (
    <SettingsProvider>
      <RootLayoutContent />
    </SettingsProvider>
  );
}

function RootLayoutContent() {
  const { theme: current, rt } = useUnistyles();
  const scheme = rt.themeName === 'dark' ? 'dark' : 'light';
  const colors = current.colors;
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
        <NotificationsProvider>
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
                  <Stack.Screen
                    name="mac/[id]/workspace"
                    options={{ title: 'Workspace', headerShadowVisible: false }}
                  />
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
                  <Stack.Screen name="mac/[id]/build" options={sheet([0.6, 1])} />
                </Stack>
              </MenuDrawer>
            </RecentsProvider>
          </HomeFiltersProvider>
        </NotificationsProvider>
      </MacsProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: { flex: 1, backgroundColor: theme.colors.background },
}));
