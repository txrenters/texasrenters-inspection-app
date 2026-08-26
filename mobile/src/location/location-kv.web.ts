/**
 * The web build has no background location task to serve — shift tracking is a
 * handset feature — so this exists to keep the module resolvable in the web
 * bundle rather than to be relied on. `localStorage` is the same choice
 * `session-storage.web` makes, and is optional-chained because the export runs
 * the module in a prerender pass where it does not exist.
 */
export const locationKeyValueStore = {
  getItem: async (key: string) => globalThis.localStorage?.getItem(key) ?? null,
  setItem: async (key: string, value: string) => globalThis.localStorage?.setItem(key, value),
  removeItem: async (key: string) => globalThis.localStorage?.removeItem(key),
};
