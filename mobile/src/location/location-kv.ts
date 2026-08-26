const values = new Map<string, string>();

/**
 * The key-value store the location queue persists into.
 *
 * Split by platform for the same reason `session-storage` is, and it is not
 * cosmetic: importing `expo-sqlite/kv-store` from a file with no platform
 * suffix pulls SQLite's *web* build into the web bundle, and that build imports
 * `wa-sqlite.wasm` through a worker Metro cannot resolve. `expo export
 * --platform web` fails outright, which is what broke CI for every branch.
 *
 * This file is the Node/test fallback. Metro selects `.native` or `.web` for
 * application bundles; Jest, which has neither SQLite nor `localStorage`, gets
 * this in-memory map.
 */
export const locationKeyValueStore = {
  getItem: async (key: string) => values.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: async (key: string) => {
    values.delete(key);
  },
};
