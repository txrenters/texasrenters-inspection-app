import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { demoStorage } from '../storage/demo-storage';

export type ThemePreference = 'light' | 'dark' | 'system';

type PreferencesState = {
  themePreference: ThemePreference;
  notificationsEnabled: boolean;
  autoUpload: boolean;
  wifiOnlyUploads: boolean;
  setThemePreference: (preference: ThemePreference) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setAutoUpload: (enabled: boolean) => void;
  setWifiOnlyUploads: (enabled: boolean) => void;
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      themePreference: 'system',
      notificationsEnabled: true,
      autoUpload: true,
      wifiOnlyUploads: false,
      setThemePreference: (themePreference) => set({ themePreference }),
      setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
      setAutoUpload: (autoUpload) => set({ autoUpload }),
      setWifiOnlyUploads: (wifiOnlyUploads) => set({ wifiOnlyUploads }),
    }),
    {
      name: 'texasrenters-inspection-preferences-v1',
      storage: createJSONStorage(() => demoStorage),
    },
  ),
);

/**
 * Non-reactive read, for the notification paths that run outside React
 * (socket handlers, reminder sync). Every place that shows a notification must
 * consult this — the toggle previously stored a value nothing read, so
 * technicians who turned notifications off still received them.
 */
export const areNotificationsEnabled = () => usePreferencesStore.getState().notificationsEnabled;
