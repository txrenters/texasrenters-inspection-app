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
    cardForeground: 'hsl(219.5 48.7% 15.3%)',
    popover: 'hsl(0 0% 100%)',
    popoverForeground: 'hsl(219.5 48.7% 15.3%)',
    primary: 'hsl(220 66.9% 34.3%)',
    primaryForeground: 'hsl(0 0% 100%)',
    secondary: 'hsl(216 38.5% 94.9%)',
    secondaryForeground: 'hsl(219.5 48.7% 15.3%)',
    muted: 'hsl(216 38.5% 94.9%)',
    mutedForeground: 'hsl(216.7 16.4% 43.1%)',
    accent: 'hsl(220 67.7% 93.9%)',
    accentForeground: 'hsl(220 66.9% 34.3%)',
    destructive: 'hsl(0 48% 48.2%)',
    destructiveForeground: 'hsl(0 0% 100%)',
    border: 'hsl(215.3 28.8% 88.4%)',
    input: 'hsl(215.3 28.8% 88.4%)',
    ring: 'hsl(220 66.9% 34.3%)',
    radius: '0.625rem',
  },
  dark: {
    background: 'hsl(220 48.8% 8.4%)',
    foreground: 'hsl(216 62.5% 96.9%)',
    card: 'hsl(217.8 42.9% 12.4%)',
    cardForeground: 'hsl(216 62.5% 96.9%)',
    popover: 'hsl(217.8 42.9% 12.4%)',
    popoverForeground: 'hsl(216 62.5% 96.9%)',
    primary: 'hsl(220.8 72.6% 67.1%)',
    primaryForeground: 'hsl(220 48.8% 8.4%)',
    secondary: 'hsl(216.4 39.8% 16.3%)',
    secondaryForeground: 'hsl(216 62.5% 96.9%)',
    muted: 'hsl(216.4 39.8% 16.3%)',
    mutedForeground: 'hsl(214.8 24.8% 75.5%)',
    accent: 'hsl(220.4 50% 20.4%)',
    accentForeground: 'hsl(220.8 72.6% 67.1%)',
    destructive: 'hsl(0 78.9% 72.2%)',
    destructiveForeground: 'hsl(220 48.8% 8.4%)',
    border: 'hsl(216.3 31.1% 23.9%)',
    input: 'hsl(216.3 31.1% 23.9%)',
    ring: 'hsl(220.8 72.6% 67.1%)',
    radius: '0.625rem',
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
      notification: THEME.light.destructive,
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
      notification: THEME.dark.destructive,
    },
  },
};
