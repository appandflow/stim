import { Platform, useColorScheme } from 'react-native';

/** Stim's brand tokens from website/src/css/custom.css, shared with apps/desktop Theme.swift. */
const light = {
  primary: '#5521FF',
  accent: '#7045FF',
  onPrimary: '#FFFFFF',
  background: '#FFFFFF',
  sidebar: '#F6F4FA',
  surface: '#FCFBFF',
  raised: '#F3EFFF',
  border: '#ECE7FA',
  screen: '#0C0A11',
  text: '#121212',
  secondary: '#6B6B6B',
  tertiary: '#96929F',
  live: '#16A34A',
  warn: '#B7791F',
  error: '#DC2626',
  remote: '#2F6BFF',
  grouped: '#F6F4FA',
  groupedRow: '#FFFFFF',
};

const dark: typeof light = {
  primary: '#B39CFF',
  accent: '#AA90FF',
  onPrimary: '#15121D',
  background: '#15121D',
  sidebar: '#0E0C13',
  surface: '#201B2B',
  raised: '#2A2338',
  border: '#352A48',
  screen: '#0C0A11',
  text: '#F3EFFF',
  secondary: '#B8B0CC',
  tertiary: '#8C84A3',
  live: '#4ADE80',
  warn: '#F5B454',
  error: '#FF6B6B',
  remote: '#7AA7FF',
  grouped: '#0E0C13',
  groupedRow: '#201B2B',
};

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

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const radius = { chip: 7, card: 12 };
