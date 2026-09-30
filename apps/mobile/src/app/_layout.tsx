import { i18n } from '@lingui/core';
import { t } from '@lingui/core/macro';
import { I18nProvider } from '@lingui/react';
import * as Sentry from '@sentry/react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { MenuDrawer } from '@/components/menu-drawer';
import { SplashOverlay } from '@/components/splash-overlay';
import { useForegroundUpdateCheck } from '@/hooks/app-update';
import { DevPairing } from '@/hooks/dev-pairing';
import { HomeFiltersProvider } from '@/hooks/home-filters';
import { InboxSync } from '@/hooks/inbox';
import { MacsProvider } from '@/hooks/machines';
import { NotificationsProvider } from '@/hooks/notifications';
import { RecentsProvider } from '@/hooks/recents';
import { SettingsProvider } from '@/hooks/settings';

SplashScreen.preventAutoHideAsync().catch(() => {});
/** expo-splash-screen fades the Android splash out over `duration` after `hide()`, over the overlay's animation. */
SplashScreen.setOptions({ duration: 0 });

/** On iPad every screen keeps the orientations the system allows, as iPad multitasking requires. */
function phoneOrientation(orientation: 'portrait_up' | 'default') {
  return Platform.OS === 'ios' && Platform.isPad ? undefined : orientation;
}

function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => SplashScreen.hide(), []);
  return (
    <View style={styles.error}>
      <EmptyState title={t`Something went wrong`} message={error.message}>
        <Button title={t`Try again`} onPress={() => void retry()} />
      </EmptyState>
    </View>
  );
}

export const ErrorBoundary = Sentry.wrapExpoRouterErrorBoundary(RootErrorBoundary);

export default function RootLayout() {
  return (
    <I18nProvider i18n={i18n}>
      <SettingsProvider>
        <RootLayoutContent />
      </SettingsProvider>
    </I18nProvider>
  );
}

function RootLayoutContent() {
  useForegroundUpdateCheck();
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
  const sheet = (detents: number[] | 'fitToContents') =>
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
      <NavigationBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <SplashOverlay>
        <MacsProvider>
          <DevPairing />
          <InboxSync />
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
                      headerShadowVisible: false,
                    }}
                  >
                    <Stack.Screen name="index" options={{ title: t`Stim` }} />
                    <Stack.Screen name="filters" options={sheet([0.6, 1])} />
                    <Stack.Screen name="about" options={sheet(Platform.OS === 'ios' ? 'fitToContents' : [0.65, 1])} />
                    <Stack.Screen
                      name="settings"
                      options={{
                        title: t`Settings`,
                        ...(Platform.OS === 'android'
                          ? {
                              contentStyle: { backgroundColor: colors.grouped },
                              headerStyle: { backgroundColor: colors.grouped },
                            }
                          : null),
                      }}
                    />
                    <Stack.Screen name="licenses" options={{ title: t`Open source licenses` }} />
                    <Stack.Screen name="license" options={{ title: '' }} />
                    <Stack.Screen name="inbox" options={{ title: t`Notifications` }} />
                    <Stack.Screen name="pair" options={{ title: t`Pair a machine`, presentation: 'modal' }} />
                    <Stack.Screen name="rename" options={{ title: t`Rename machine`, presentation: 'modal' }} />
                    <Stack.Screen name="mac/[id]/index" options={sheet([0.75, 1])} />
                    <Stack.Screen name="mac/[id]/workspace" options={{ title: t`Workspace` }} />
                    <Stack.Screen name="mac/[id]/logs" options={{ title: t`Logs` }} />
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
                    <Stack.Screen name="mac/[id]/build" options={sheet([0.75, 1])} />
                    <Stack.Screen name="mac/[id]/resources" options={sheet([0.75, 1])} />
                    <Stack.Screen name="mac/[id]/agent" options={sheet([0.75, 1])} />
                    <Stack.Screen name="mac/[id]/work" options={sheet([0.65, 1])} />
                  </Stack>
                </MenuDrawer>
              </RecentsProvider>
            </HomeFiltersProvider>
          </NotificationsProvider>
        </MacsProvider>
      </SplashOverlay>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: { flex: 1, backgroundColor: theme.colors.background },
}));
