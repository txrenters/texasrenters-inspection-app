'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'texasrenters-admin-theme';

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  setPreference: () => undefined,
});

function applyTheme(preference: ThemePreference) {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initial = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    setPreferenceState(initial);
    applyTheme(initial);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(preference);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      setPreference: (next) => {
        setPreferenceState(next);
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
        applyTheme(next);
      },
    }),
    [preference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeSelector() {
  const { preference, setPreference } = useContext(ThemeContext);
  const options = [
    { value: 'light' as const, label: 'Light theme', Icon: Sun },
    { value: 'dark' as const, label: 'Dark theme', Icon: Moon },
    { value: 'system' as const, label: 'Use system theme', Icon: Monitor },
  ];
  return (
    <div className="theme-selector" aria-label="Color theme" role="group">
      {options.map((option) => (
        <button
          aria-label={option.label}
          aria-pressed={preference === option.value}
          className={preference === option.value ? 'active' : ''}
          key={option.value}
          onClick={() => setPreference(option.value)}
          title={option.label}
          type="button"
        >
          <option.Icon aria-hidden className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
