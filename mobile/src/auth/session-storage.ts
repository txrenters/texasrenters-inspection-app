const values = new Map<string, string>();

// Node/test fallback. Metro selects the native or web implementation for application bundles.
export const sessionStorage = {
  getItem: async (key: string) => values.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: async (key: string) => {
    values.delete(key);
  },
};
