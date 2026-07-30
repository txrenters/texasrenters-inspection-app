import * as SecureStore from 'expo-secure-store';
import SQLiteStorage from 'expo-sqlite/kv-store';

// Supabase sessions hold access and refresh tokens, so they belong in the
// device keychain/keystore, not plaintext SQLite. SecureStore values are
// limited to ~2 KB on some platforms, and a serialized session exceeds that,
// so values are split across numbered chunks with a chunk-count marker.
const CHUNK_SIZE = 1800;

const marker = (key: string) => `${sanitize(key)}.chunks`;
const chunk = (key: string, index: number) => `${sanitize(key)}.${index}`;

function sanitize(key: string) {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function readChunks(key: string) {
  const countRaw = await SecureStore.getItemAsync(marker(key));
  const count = Number(countRaw);
  if (!countRaw || !Number.isInteger(count) || count < 1) return null;
  const parts = await Promise.all(
    Array.from({ length: count }, (_, index) => SecureStore.getItemAsync(chunk(key, index))),
  );
  if (parts.some((part) => part === null)) return null;
  return parts.join('');
}

async function writeChunks(key: string, value: string) {
  const previous = Number(await SecureStore.getItemAsync(marker(key))) || 0;
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += CHUNK_SIZE)
    parts.push(value.slice(offset, offset + CHUNK_SIZE));
  for (const [index, part] of parts.entries())
    await SecureStore.setItemAsync(chunk(key, index), part);
  await SecureStore.setItemAsync(marker(key), String(parts.length));
  for (let index = parts.length; index < previous; index += 1)
    await SecureStore.deleteItemAsync(chunk(key, index));
}

async function removeChunks(key: string) {
  const count = Number(await SecureStore.getItemAsync(marker(key))) || 0;
  await SecureStore.deleteItemAsync(marker(key));
  for (let index = 0; index < count; index += 1)
    await SecureStore.deleteItemAsync(chunk(key, index));
}

export const sessionStorage = {
  getItem: async (key: string) => {
    const secureValue = await readChunks(key);
    if (secureValue !== null) return secureValue;
    // Migrate sessions written by builds that stored them in plaintext SQLite.
    const legacyValue = await SQLiteStorage.getItem(key);
    if (legacyValue === null) return null;
    await writeChunks(key, legacyValue);
    await SQLiteStorage.removeItem(key);
    return legacyValue;
  },
  setItem: async (key: string, value: string) => {
    await writeChunks(key, value);
  },
  removeItem: async (key: string) => {
    await Promise.all([removeChunks(key), SQLiteStorage.removeItem(key)]);
  },
};
