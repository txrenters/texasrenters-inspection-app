import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { Platform } from 'react-native';

let notificationHandlerConfigured = false;

/**
 * Lazily loads expo-notifications, guarded against web and Expo Go (where remote
 * push and some scheduling APIs are unavailable), and configures the singleton
 * notification handler exactly once. Returns null when notifications cannot be
 * used in the current runtime.
 */
export async function loadNotifications(): Promise<typeof ExpoNotifications | null> {
  if (!['ios', 'android'].includes(Platform.OS) || Constants.executionEnvironment === 'storeClient')
    return null;
  const Notifications = await import('expo-notifications');
  if (!notificationHandlerConfigured) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    notificationHandlerConfigured = true;
  }
  return Notifications;
}
