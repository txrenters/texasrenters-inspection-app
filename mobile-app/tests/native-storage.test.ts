import * as SecureStore from 'expo-secure-store';
import { Storage as SQLiteStorage } from 'expo-sqlite/kv-store';

import { demoStorage } from '../src/storage/demo-storage.native';

describe('native app storage', () => {
  const mockedSQLiteStorage = SQLiteStorage as jest.Mocked<typeof SQLiteStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores large non-sensitive state in SQLite instead of SecureStore', async () => {
    const largeValue = 'x'.repeat(5_000);

    await demoStorage.setItem('large-state', largeValue);

    expect(mockedSQLiteStorage.setItem).toHaveBeenCalledWith('large-state', largeValue);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('migrates legacy SecureStore values on first read', async () => {
    await SecureStore.setItemAsync('legacy-state', 'saved-state');
    jest.clearAllMocks();

    await expect(demoStorage.getItem('legacy-state')).resolves.toBe('saved-state');
    expect(mockedSQLiteStorage.setItem).toHaveBeenCalledWith('legacy-state', 'saved-state');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('legacy-state');
  });

  it('removes current and legacy copies', async () => {
    await demoStorage.removeItem('demo-state');

    expect(mockedSQLiteStorage.removeItem).toHaveBeenCalledWith('demo-state');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('demo-state');
  });
});
