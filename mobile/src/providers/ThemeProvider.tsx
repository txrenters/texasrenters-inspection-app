// ThemeProvider.tsx — simple, no context, no throw
import { useColorScheme } from 'nativewind';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { lightTheme, darkTheme } from '@/theme';
import { usePreferencesStore } from '@/src/stores/preferences.store';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const { colorScheme, setColorScheme } = useColorScheme();
  const themePreference = usePreferencesStore((state) => state.themePreference);
  const isDark = colorScheme === 'dark';
  const themeVars = isDark ? darkTheme : lightTheme;

  useEffect(() => {
    setColorScheme(themePreference);
  }, [setColorScheme, themePreference]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const root = document.documentElement;
    const vars: Record<string, string> = (themeVars as any).__cssVars ?? themeVars;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, String(value));
    }
    root.classList.remove('light', 'dark');
    if (colorScheme) root.classList.add(colorScheme);
    return () => {
      for (const key of Object.keys(vars)) {
        root.style.removeProperty(key);
      }
    };
  }, [themeVars, colorScheme]);

  return (
    <View style={themeVars} className={`${colorScheme} flex-1 bg-background`}>
      {children}
    </View>
  );
}

// Plain export — NO context, NO useContext, NO throw
export const useTheme = () => {
  const { colorScheme } = useColorScheme();
  return {
    isDark: colorScheme === 'dark',
    colorScheme,
  };
};
