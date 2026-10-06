import type { StateStorage } from 'zustand/middleware';

export const demoStorage: StateStorage = {
  getItem: async (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: async (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: async (name) => globalThis.localStorage?.removeItem(name),
};

/** Synchronous access to the same values; see the native module. */
export const demoStorageNow = {
  getItem: (name: string): string | null => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name: string, value: string): void => globalThis.localStorage?.setItem(name, value),
};
