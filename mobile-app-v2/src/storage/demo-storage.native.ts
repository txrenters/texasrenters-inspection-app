import * as SecureStore from 'expo-secure-store';
import { Storage as SQLiteStorage } from 'expo-sqlite/kv-store';
import type { StateStorage } from 'zustand/middleware';

import { isValidSecureStoreKey } from './secure-store-key';

export const demoStorage: StateStorage = {
  getItem: async (name) => {
    const storedValue = await SQLiteStorage.getItem(name);
    if (storedValue !== null) return storedValue;

    // Migrate state written by builds that persisted all demo data in SecureStore.
    // API cache keys contain ":" and "/" and were never valid SecureStore keys.
    if (!isValidSecureStoreKey(name)) return null;
    const legacyValue = await SecureStore.getItemAsync(name);
    if (legacyValue === null) return null;

    await SQLiteStorage.setItem(name, legacyValue);
    await SecureStore.deleteItemAsync(name);
    return legacyValue;
  },
  setItem: (name, value) => SQLiteStorage.setItem(name, value),
  removeItem: async (name) => {
    await SQLiteStorage.removeItem(name);
    if (isValidSecureStoreKey(name)) await SecureStore.deleteItemAsync(name);
  },
};
