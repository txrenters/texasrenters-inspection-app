import { Storage as SQLiteStorage } from 'expo-sqlite/kv-store';

/**
 * `expo-sqlite/kv-store` directly rather than through the app's zustand stores:
 * background location is delivered to a `TaskManager` task the OS may run with
 * no app on screen, where nothing has hydrated and no React state exists. This
 * reaches the same store the rest of the app persists into, without React.
 *
 * Native only, by filename. The web build of this package is what Metro cannot
 * bundle — see the note in `location-kv.ts`.
 */
export const locationKeyValueStore = {
  getItem: (key: string) => SQLiteStorage.getItem(key),
  setItem: (key: string, value: string) => SQLiteStorage.setItem(key, value),
  removeItem: (key: string) => SQLiteStorage.removeItem(key),
};
