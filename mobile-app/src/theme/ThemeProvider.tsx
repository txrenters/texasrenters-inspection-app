import { createContext, type PropsWithChildren, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import { usePreferencesStore, type ThemePreference } from '../stores/preferences.store';
import { darkColors, lightColors, type AppColors } from './colors';

export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ReturnType<typeof useColorScheme>,
): ResolvedTheme {
  return preference === 'system' ? (systemTheme === 'dark' ? 'dark' : 'light') : preference;
}

type AppTheme = {
  colors: AppColors;
  isDark: boolean;
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

const defaultTheme: AppTheme = {
  colors: lightColors,
  isDark: false,
  preference: 'system',
  resolvedTheme: 'light',
  setPreference: () => undefined,
};

const AppThemeContext = createContext<AppTheme>(defaultTheme);

export function AppThemeProvider({ children }: PropsWithChildren) {
  const systemTheme = useColorScheme();
  const preference = usePreferencesStore((state) => state.themePreference);
  const setPreference = usePreferencesStore((state) => state.setThemePreference);
  const resolvedTheme = resolveTheme(preference, systemTheme);

  const value = useMemo<AppTheme>(
    () => ({
      colors: resolvedTheme === 'dark' ? darkColors : lightColors,
      isDark: resolvedTheme === 'dark',
      preference,
      resolvedTheme,
      setPreference,
    }),
    [preference, resolvedTheme, setPreference],
  );

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

export function useAppTheme() {
  return useContext(AppThemeContext);
}

export function useThemedStyles<Styles>(factory: (colors: AppColors) => Styles) {
  const { colors } = useAppTheme();
  return useMemo(() => factory(colors), [colors, factory]);
}
