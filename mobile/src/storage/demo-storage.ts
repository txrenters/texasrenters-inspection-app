import type { StateStorage } from 'zustand/middleware';

const memory = new Map<string, string>();

export const demoStorage: StateStorage = {
  getItem: async (name) => memory.get(name) ?? null,
  setItem: async (name, value) => {
    memory.set(name, value);
  },
  removeItem: async (name) => {
    memory.delete(name);
  },
};

/** Synchronous access to the same values; see the native module. */
export const demoStorageNow = {
  getItem: (name: string): string | null => memory.get(name) ?? null,
  setItem: (name: string, value: string): void => {
    memory.set(name, value);
  },
};
