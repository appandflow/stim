import { Platform, useColorScheme } from 'react-native';

import { colors, fonts, media, radius as radii } from '@/design/tokens';

function legacyColors(scheme: 'light' | 'dark') {
  const c = colors[scheme];
  return {
    primary: c.primary,
    accent: c.accent,
    onPrimary: c.onPrimary,
    background: c.background,
    sidebar: c.sidebar,
    surface: c.surface,
    raised: c.raised,
    border: c.border,
    screen: media.screen,
    text: c.text,
    secondary: c.secondary,
    tertiary: c.tertiary,
    live: c.success,
    warn: c.warning,
    error: c.error,
    remote: c.info,
    grouped: c.grouped,
    groupedRow: c.groupedRow,
  };
}

const light = legacyColors('light');
const dark = legacyColors('dark');

export type Colors = typeof light;

export type Appearance = 'system' | 'light' | 'dark';

/**
 * The Settings screen's Appearance choice applies with `Appearance.setColorScheme`, which overrides
 * `useColorScheme()` (and the OS-native chrome: nav bars, `@expo/ui`'s SwiftUI controls) app-wide, so reading the
 * system scheme here already reflects it.
 */
export function useEffectiveScheme(): 'light' | 'dark' {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

export function useColors(): Colors {
  return useEffectiveScheme() === 'dark' ? dark : light;
}

export const mono = Platform.select({ ios: fonts.mono.ios, default: fonts.mono.android });

export const radius = { chip: radii.chip, card: radii.card };
