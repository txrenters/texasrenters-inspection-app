import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { io, type Socket } from 'socket.io-client';

import { getSession, onSessionChange } from '../auth/session';
import { environment, isDemoMode, resolveEasProjectId } from '../config/environment';
import { queryKeys } from '../features/queries';
import { reportError } from '../lib/error-log';
import { verifyQueries } from '../features/state-consistency';
import { requestJson } from '../repositories/api/repositories';
import { areNotificationsEnabled, usePreferencesStore } from '../stores/preferences.store';
import { loadNotifications, shouldNotifyLocally } from './notifications';
import { pushDeviceStorage } from './push-device-storage';

type NotificationsModule = typeof ExpoNotifications;

interface InspectionChangedEvent {
  inspectionId: string;
  kind:
    | 'ASSIGNED'
    | 'REASSIGNED'
    | 'UNASSIGNED'
    | 'CANCELLED'
    | 'UPDATED'
    | 'REOPENED'
    | 'EVIDENCE_REQUESTED'
    /** This technician's own change, reaching their other devices. Never notified. */
    | 'SYNCED';
  occurredAt: string;
}

export function TechnicianRealtimeProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isDemoMode) return;
    let socket: Socket | undefined;
    let disposed = false;
    let registeredPushToken: string | undefined;
    let notificationResponse: { remove(): void } | undefined;

    const refreshAssignments = () => {
      void verifyQueries(queryClient, [queryKeys.dashboard, queryKeys.inspectionsRoot]);
    };

    const connect = async () => {
      const baseUrl = environment.realtimeBaseUrls[0];
      if (!baseUrl || disposed) return;
      const session = await getSession();
      if (!session || disposed) return;
      if (!registeredPushToken) {
        registeredPushToken = await registerRemotePushDevice();
      }
      // A switch-off that could not reach the server is finished here, on the
      // next connection, rather than leaving the device registered for good.
      if (!areNotificationsEnabled()) void unregisterRemotePushDevice();
      socket?.disconnect();
      socket = io(`${baseUrl}/technician-events`, {
        auth: { accessToken: session.accessToken },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 10_000,
      });
      socket.on('technician:ready', refreshAssignments);
      socket.on('inspection:changed', (event: InspectionChangedEvent) => {
        refreshAssignments();
        void verifyQueries(queryClient, [
          queryKeys.inspection(event.inspectionId),
          // The outstanding list, on every kind rather than only
          // EVIDENCE_REQUESTED: resolving a request, finishing an inspection or
          // losing an assignment all change what is still waiting, and a badge
          // that only ever counts up is worse than none.
          queryKeys.openEvidenceRequests,
        ]);
        // Not only when no token is registered: a foreground push arrives and
        // is then dropped without being shown, so a technician working inside
        // one inspection heard nothing about the next one. See
        // shouldNotifyLocally for what was measured and why the app state is
        // part of the rule.
        if (shouldNotifyLocally(Boolean(registeredPushToken), AppState.currentState))
          void notifyTechnician(event.kind, event.inspectionId).catch(() => undefined);
      });
    };

    const connectSafely = () => {
      void connect().catch(() => undefined);
    };

    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      refreshAssignments();
      if (!socket?.connected) connectSafely();
    });
    // The socket authenticates with a token captured at connect, so it has to
    // be rebuilt when the session changes and torn down when it goes.
    /**
     * The Settings toggle, followed while the app runs.
     *
     * Off used to stop only what this app raises itself. The device stayed
     * registered, so the server kept pushing, and a push is shown whether the
     * app is open or not. Off now removes the registration; on restores it.
     */
    const unsubscribePreference = usePreferencesStore.subscribe((state, previous) => {
      if (state.notificationsEnabled === previous.notificationsEnabled) return;
      if (!state.notificationsEnabled) {
        registeredPushToken = undefined;
        void unregisterRemotePushDevice();
        return;
      }
      void registerRemotePushDevice().then((token) => {
        if (!disposed) registeredPushToken = token;
      });
    });
    const unsubscribeSession = onSessionChange((session) => {
      if (session) connectSafely();
      else {
        socket?.disconnect();
        socket = undefined;
      }
    });
    void loadNotifications()
      .then((Notifications) => {
        if (!Notifications || disposed) return;
        notificationResponse = Notifications.addNotificationResponseReceivedListener((response) => {
          const inspectionId = response.notification.request.content.data.inspectionId;
          if (typeof inspectionId === 'string')
            router.push(`/(app)/inspections/${inspectionId}` as never);
        });
      })
      .catch(() => undefined);
    connectSafely();

    return () => {
      disposed = true;
      socket?.disconnect();
      appState.remove();
      unsubscribePreference();
      unsubscribeSession();
      notificationResponse?.remove();
    };
  }, [queryClient]);

  return children;
}

async function configureNotifications(Notifications: NotificationsModule | null) {
  if (!Notifications) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('assignments', {
      name: 'Inspection assignments',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    });
  }
  const existing = await Notifications.getPermissionsAsync();
  if (!existing.granted && existing.canAskAgain) await Notifications.requestPermissionsAsync();
}

async function registerRemotePushDevice() {
  if (!['ios', 'android'].includes(Platform.OS)) return undefined;
  // Registering a push token while the preference is off would let the server
  // keep pushing to a device whose owner opted out.
  if (!areNotificationsEnabled()) return undefined;
  try {
    const Notifications = await loadNotifications();
    if (!Notifications) return undefined;
    await configureNotifications(Notifications);
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return pushUnavailable('Notification permission was not granted.');
    const projectId = resolveEasProjectId(
      Constants.easConfig?.projectId,
      (Constants.expoConfig?.extra?.eas as { projectId?: unknown } | undefined)?.projectId,
    );
    if (!projectId)
      return pushUnavailable(
        'This build has no EAS project id, so Expo cannot issue a push token.',
      );
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await requestJson('/api/v1/technician/notification-devices', {
      method: 'POST',
      body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }),
    });
    await pushDeviceStorage.set(token);
    return token;
  } catch (error) {
    return pushUnavailable(error);
  }
}

/**
 * Stops the server pushing to this device, for a technician who switched
 * notifications off.
 *
 * The stored token is forgotten only once the server has agreed. Offline, it is
 * kept, and the next connection tries again -- clearing it first would leave
 * the server pushing to a phone that no longer knows it is registered.
 */
async function unregisterRemotePushDevice() {
  if (!['ios', 'android'].includes(Platform.OS)) return;
  const token = await pushDeviceStorage.get().catch(() => null);
  if (!token) return;
  try {
    await requestJson('/api/v1/technician/notification-devices', {
      method: 'DELETE',
      body: JSON.stringify({ expoPushToken: token }),
    });
    await pushDeviceStorage.clear();
  } catch (error) {
    void reportError(error, { source: 'push-unregistration' });
  }
}

/**
 * Records why this device will not receive pushes, then gives up quietly.
 *
 * Every failure here used to end at a bare `return undefined`, which is how
 * "push notifications do not work" arrived with no evidence at all: a denied
 * permission, an EAS project with no FCM credential and a rejected POST were
 * all indistinguishable, on the handset and in the backend alike. Registration
 * stays best-effort — a technician must still be able to work — but the reason
 * now reaches Diagnostics, which is the only channel they have in the field.
 */
function pushUnavailable(reason: unknown) {
  void reportError(reason, { source: 'push-registration' });
  return undefined;
}

/**
 * Copy for the events a technician has to be told about immediately.
 *
 * Only kinds that put work back in their hands. The assignment churn kinds
 * refresh the queue silently — a notification for every edit the office makes is
 * how people learn to ignore them.
 *
 * UPDATED is on this list rather than among them, because the server only ever
 * publishes it when the office adds an area to an inspection this technician is
 * already carrying. That is more rooms to walk, and someone who has finished and
 * left needs to hear about it before they drive away.
 *
 * SYNCED is deliberately absent. It is the technician's own change reaching
 * their other devices; it used to arrive as UPDATED, and told them "The office
 * added an area" after nearly every button they pressed.
 *
 * Mirrors MobilePushService.COPY on the server, which fires instead of this
 * whenever a push token is registered. The two lists must agree: a kind here and
 * not there is silent for anyone with the app closed, and the reverse is a
 * technician notified twice for one event.
 */
const NOTIFIABLE: Partial<Record<string, { title: string; body: string }>> = {
  ASSIGNED: {
    title: 'New inspection assigned',
    body: 'A new inspection is ready in your TexasRenters workspace.',
  },
  REOPENED: {
    title: 'Inspection sent back',
    body: 'The office returned an inspection to you. Open it to read why.',
  },
  EVIDENCE_REQUESTED: {
    title: 'More evidence requested',
    body: 'The office asked for more evidence on one of your areas.',
  },
  UPDATED: {
    title: 'Inspection updated',
    body: 'The office added an area to one of your inspections.',
  },
};

async function notifyTechnician(kind: string, inspectionId: string) {
  const copy = NOTIFIABLE[kind];
  if (!copy) return;
  if (!areNotificationsEnabled()) return;
  const Notifications = await loadNotifications();
  if (!Notifications) return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  await Notifications.scheduleNotificationAsync({
    content: { ...copy, data: { inspectionId }, sound: true },
    trigger: null,
  });
}
