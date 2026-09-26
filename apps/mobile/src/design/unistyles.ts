import { Appearance } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { themes } from '@/design/theme';
import { breakpoints } from '@/design/tokens';

type Themes = typeof themes;
type Breakpoints = typeof breakpoints;

/* eslint-disable @typescript-eslint/no-empty-object-type -- Unistyles reads its theme and breakpoint types through these merged interfaces. */
declare module 'react-native-unistyles' {
  export interface UnistylesThemes extends Themes {}
  export interface UnistylesBreakpoints extends Breakpoints {}
}
/* eslint-enable @typescript-eslint/no-empty-object-type */

const themeForScheme = () => (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light');

/**
 * Unistyles' `adaptiveThemes` follows only the system appearance and ignores `Appearance.setColorScheme`, which the
 * Settings Appearance choice uses, so the theme follows React Native's color scheme instead.
 */
StyleSheet.configure({ themes, breakpoints, settings: { initialTheme: themeForScheme } });

Appearance.addChangeListener(() => {
  const next = themeForScheme();
  if (UnistylesRuntime.themeName !== next) UnistylesRuntime.setTheme(next);
});
