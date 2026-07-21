import type { StateStorage } from 'zustand/middleware';

export const demoStorage: StateStorage = {
  getItem: async (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: async (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: async (name) => globalThis.localStorage?.removeItem(name),
};
