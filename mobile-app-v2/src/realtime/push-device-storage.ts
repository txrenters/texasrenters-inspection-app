import * as SecureStore from 'expo-secure-store';

const PUSH_TOKEN_KEY = 'texasrenters.expo-push-token';

export const pushDeviceStorage = {
  get: () => SecureStore.getItemAsync(PUSH_TOKEN_KEY),
  set: (token: string) => SecureStore.setItemAsync(PUSH_TOKEN_KEY, token),
  clear: () => SecureStore.deleteItemAsync(PUSH_TOKEN_KEY),
};
