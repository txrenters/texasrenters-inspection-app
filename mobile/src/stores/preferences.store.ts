import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { demoStorage } from '../storage/demo-storage';

export type ThemePreference = 'light' | 'dark' | 'system';

type PreferencesState = {
  themePreference: ThemePreference;
  notificationsEnabled: boolean;
  autoUpload: boolean;
  wifiOnlyUploads: boolean;
  /**
   * Whether location recording is paused.
   *
   * Named for the exception rather than the rule, because the rule is now
   * automatic: a signed-in technician is recorded while the app is open,
   * without doing anything. This exists so that "without doing anything" does
   * not also mean "with no way to stop" -- a personal errand, a day off, a
   * handset shared with family.
   *
   * Defaults to false: on, unless somebody turned it off on purpose.
   */
  locationPaused: boolean;
  setThemePreference: (preference: ThemePreference) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setAutoUpload: (enabled: boolean) => void;
  setWifiOnlyUploads: (enabled: boolean) => void;
  setLocationPaused: (paused: boolean) => void;
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      themePreference: 'system',
      notificationsEnabled: true,
      autoUpload: true,
      wifiOnlyUploads: false,
      locationPaused: false,
      setThemePreference: (themePreference) => set({ themePreference }),
      setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
      setAutoUpload: (autoUpload) => set({ autoUpload }),
      setWifiOnlyUploads: (wifiOnlyUploads) => set({ wifiOnlyUploads }),
      setLocationPaused: (locationPaused) => set({ locationPaused }),
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

/** Non-reactive read, for the startup path that runs before React settles. */
export const isLocationPaused = () => usePreferencesStore.getState().locationPaused;
