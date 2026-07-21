import * as SecureStore from 'expo-secure-store';
import { Storage as SQLiteStorage } from 'expo-sqlite/kv-store';
import type { StateStorage } from 'zustand/middleware';

export const demoStorage: StateStorage = {
  getItem: async (name) => {
    const storedValue = await SQLiteStorage.getItem(name);
    if (storedValue !== null) return storedValue;

    // Migrate state written by builds that persisted all demo data in SecureStore.
    const legacyValue = await SecureStore.getItemAsync(name);
    if (legacyValue === null) return null;

    await SQLiteStorage.setItem(name, legacyValue);
    await SecureStore.deleteItemAsync(name);
    return legacyValue;
  },
  setItem: (name, value) => SQLiteStorage.setItem(name, value),
  removeItem: async (name) => {
    await Promise.all([SQLiteStorage.removeItem(name), SecureStore.deleteItemAsync(name)]);
  },
};
