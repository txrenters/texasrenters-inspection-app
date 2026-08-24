import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { Platform, type AppStateStatus } from 'react-native';

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

/**
 * Whether the app should raise the notification for a socket event itself,
 * rather than leaving it to the server's push.
 *
 * Two cases, and they are not the same one:
 *
 *   - No push token registered. Nothing will ever arrive from the server, so
 *     the app is the only thing that can tell the technician. Holds in any app
 *     state, including backgrounded with a live socket.
 *   - App in the foreground. The push *does* arrive, and is then dropped
 *     without being shown — Android counts it `numEnqueuedByApp=1,
 *     numPostedByApp=0`. Measured on device; the handler in this file asks for
 *     a banner and the native side honours it everywhere else, so this is not
 *     something the handler can fix.
 *
 * Deliberately not `!hasPushToken || anyBackgroundState`: a backgrounded app
 * can still hold a connected socket, and there the push is displayed normally.
 * Notifying locally as well would show the same event twice.
 */
export function shouldNotifyLocally(hasPushToken: boolean, appState: AppStateStatus) {
  return !hasPushToken || appState === 'active';
}
