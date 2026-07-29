(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { hostUri: '192.168.1.24:8082' } },
}));

const mockSecureValues = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureValues.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => mockSecureValues.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => mockSecureValues.delete(key)),
}));

const mockSQLiteValues = new Map<string, string>();
const mockSQLiteStorage = {
  getItem: jest.fn(async (key: string) => mockSQLiteValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockSQLiteValues.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockSQLiteValues.delete(key);
  }),
};
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  AsyncStorage: mockSQLiteStorage,
  Storage: mockSQLiteStorage,
  default: mockSQLiteStorage,
}));
