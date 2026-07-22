import * as SecureStore from 'expo-secure-store';
import SQLiteStorage from 'expo-sqlite/kv-store';

import { sessionStorage } from '../src/auth/session-storage.native';

const KEY = 'sb-project-auth-token';

describe('secure session storage', () => {
  beforeEach(async () => {
    await sessionStorage.removeItem(KEY);
    jest.clearAllMocks();
  });

  it('round-trips values larger than a single SecureStore entry', async () => {
    const value = JSON.stringify({ access_token: 'a'.repeat(3000), refresh_token: 'r'.repeat(900) });
    await sessionStorage.setItem(KEY, value);

    await expect(sessionStorage.getItem(KEY)).resolves.toBe(value);
    // 3.9K+ payload must span multiple keychain entries plus the marker.
    const setCalls = (SecureStore.setItemAsync as jest.Mock).mock.calls.map(([name]) => name);
    expect(setCalls.filter((name) => /\.\d+$/.test(name)).length).toBeGreaterThan(1);
  });

  it('shrinking values deletes stale chunks', async () => {
    await sessionStorage.setItem(KEY, 'x'.repeat(4000));
    await sessionStorage.setItem(KEY, 'short');

    await expect(sessionStorage.getItem(KEY)).resolves.toBe('short');
  });

  it('migrates plaintext SQLite sessions into SecureStore', async () => {
    const legacy = JSON.stringify({ access_token: 'legacy' });
    await SQLiteStorage.setItem(KEY, legacy);

    await expect(sessionStorage.getItem(KEY)).resolves.toBe(legacy);
    expect(SQLiteStorage.removeItem).toHaveBeenCalledWith(KEY);
    // Subsequent reads come from SecureStore.
    await expect(sessionStorage.getItem(KEY)).resolves.toBe(legacy);
  });

  it('removeItem clears every chunk and the marker', async () => {
    await sessionStorage.setItem(KEY, 'y'.repeat(4000));
    await sessionStorage.removeItem(KEY);

    await expect(sessionStorage.getItem(KEY)).resolves.toBeNull();
  });
});
