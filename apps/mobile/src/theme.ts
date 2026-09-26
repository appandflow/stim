import { createContext, useContext } from 'react';
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
};

export type Colors = typeof light;

export type Appearance = 'system' | 'light' | 'dark';

/** Overrides the system color scheme when the Settings screen's Appearance choice is not "System". */
export const AppearanceOverride = createContext<Appearance>('system');

export function useEffectiveScheme(): 'light' | 'dark' {
  const override = useContext(AppearanceOverride);
  const system = useColorScheme();
  return (override === 'system' ? system : override) === 'dark' ? 'dark' : 'light';
}

export function useColors(): Colors {
  return useEffectiveScheme() === 'dark' ? dark : light;
}

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const radius = { chip: 7, card: 12 };
