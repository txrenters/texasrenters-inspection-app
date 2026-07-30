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
