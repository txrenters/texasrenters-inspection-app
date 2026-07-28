import type { Theme } from '@react-navigation/native';
import { DarkTheme, DefaultTheme } from '@react-navigation/native';

/**
 * Navigation themes kept in step with the semantic tokens in global.css.
 *
 * These values are the resolved form of the same palette in src/theme/colors.ts —
 * React Navigation cannot read CSS variables, so the hex is repeated here. When a
 * token changes, change it in colors.ts and global.css first, then mirror it.
 */
export const THEME = {
  light: {
    background: 'hsl(220 42.9% 97.3%)',
    foreground: 'hsl(219.5 48.7% 15.3%)',
    card: 'hsl(0 0% 100%)',
    primary: 'hsl(220.5 66.4% 34.3%)',
    border: 'hsl(213.3 25.5% 88.4%)',
    notification: 'hsl(0 47.5% 48.2%)',
  },
  dark: {
    background: 'hsl(220.9 48.4% 8.8%)',
    foreground: 'hsl(216 66.7% 96.5%)',
    card: 'hsl(218.9 41.5% 12.4%)',
    primary: 'hsl(220.3 70.6% 67.5%)',
    border: 'hsl(219.1 30.4% 24.3%)',
    notification: 'hsl(0 79.2% 72.5%)',
  },
} as const;

export const NAV_THEME: Record<'light' | 'dark', Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: THEME.light.background,
      card: THEME.light.card,
      text: THEME.light.foreground,
      primary: THEME.light.primary,
      border: THEME.light.border,
      notification: THEME.light.notification,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      background: THEME.dark.background,
      card: THEME.dark.card,
      text: THEME.dark.foreground,
      primary: THEME.dark.primary,
      border: THEME.dark.border,
      notification: THEME.dark.notification,
    },
  },
};
