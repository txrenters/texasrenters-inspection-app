import * as SecureStore from 'expo-secure-store';
import { Storage as SQLiteStorage } from 'expo-sqlite/kv-store';

import { demoStorage } from '../src/storage/demo-storage.native';

describe('mobile v2 native storage', () => {
  const mockedSQLiteStorage = SQLiteStorage as jest.Mocked<typeof SQLiteStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores non-sensitive state in SQLite instead of SecureStore', async () => {
    await demoStorage.setItem('large-state', 'x'.repeat(5_000));

    expect(mockedSQLiteStorage.setItem).toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('migrates a legacy value only when its SecureStore key is valid', async () => {
    await SecureStore.setItemAsync('legacy-state', 'saved-state');
    jest.clearAllMocks();

    await expect(demoStorage.getItem('legacy-state')).resolves.toBe('saved-state');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('legacy-state');
    expect(mockedSQLiteStorage.setItem).toHaveBeenCalledWith('legacy-state', 'saved-state');
  });

  it('does not pass REST cache keys containing colons and slashes to SecureStore', async () => {
    const apiCacheKey =
      'texasrenters-offline-records-v1:user-id:/api/v1/technician/dashboard';

    await expect(demoStorage.getItem(apiCacheKey)).resolves.toBeNull();
    await expect(demoStorage.removeItem(apiCacheKey)).resolves.toBeUndefined();

    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(mockedSQLiteStorage.removeItem).toHaveBeenCalledWith(apiCacheKey);
  });
});
