const SECURE_STORE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Expo SecureStore rejects empty keys and keys containing characters such as
 * ":" or "/". Non-sensitive REST cache keys intentionally contain those
 * characters and live in SQLite, so their legacy SecureStore migration must be
 * skipped instead of passing an invalid key to the native module.
 */
export function isValidSecureStoreKey(key: string) {
  return key.length > 0 && SECURE_STORE_KEY_PATTERN.test(key);
}
