import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useGlobalSearchParams, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

import { useDevPairing } from '@/hooks/dev-pairing';
import { MacConnectionProvider } from '@/hooks/mac-connection';
import { useColors } from '@/theme';

export default function RootLayout() {
  const scheme = useColorScheme();
  const colors = useColors();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const onMac = usePathname().startsWith('/mac/');
  useDevPairing();
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
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="auto" />
      <MacConnectionProvider id={onMac ? (id ?? null) : null}>
        <Stack screenOptions={{ headerTintColor: colors.primary, headerTitleStyle: { color: colors.text } }}>
          <Stack.Screen name="index" options={{ title: 'Macs', headerLargeTitle: true }} />
          <Stack.Screen name="pair" options={{ title: 'Pair a Mac', presentation: 'modal' }} />
          <Stack.Screen name="rename" options={{ title: 'Rename Mac', presentation: 'modal' }} />
          <Stack.Screen name="mac/[id]/index" options={{ title: 'Workspaces', headerLargeTitle: true }} />
          <Stack.Screen name="mac/[id]/workspace" options={{ title: 'Workspace' }} />
          <Stack.Screen name="mac/[id]/logs" options={{ title: 'Logs' }} />
        </Stack>
      </MacConnectionProvider>
    </ThemeProvider>
  );
}
