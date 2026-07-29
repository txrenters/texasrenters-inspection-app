import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { demoStorage } from '../storage/demo-storage';

export type ThemePreference = 'light' | 'dark' | 'system';

type PreferencesState = {
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      themePreference: 'system',
      setThemePreference: (themePreference) => set({ themePreference }),
    }),
    {
      name: 'texasrenters-inspection-preferences-v1',
      storage: createJSONStorage(() => demoStorage),
    },
  ),
);
