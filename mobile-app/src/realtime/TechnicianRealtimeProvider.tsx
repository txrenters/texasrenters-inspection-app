import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { io, type Socket } from 'socket.io-client';

import { getSupabaseClient } from '../auth/supabase';
import { environment, isDemoMode, resolveEasProjectId } from '../config/environment';
import { queryKeys } from '../features/queries';
import { requestJson } from '../repositories/api/repositories';
import { loadNotifications } from './notifications';
import { pushDeviceStorage } from './push-device-storage';

type NotificationsModule = typeof ExpoNotifications;

interface InspectionChangedEvent {
  inspectionId: string;
  kind: 'ASSIGNED' | 'REASSIGNED' | 'UNASSIGNED' | 'CANCELLED' | 'UPDATED';
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
      void Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: ['inspections'] }),
      ]);
    };

    const connect = async () => {
      const baseUrl = environment.realtimeBaseUrls[0];
      if (!baseUrl || disposed) return;
      const { data } = await getSupabaseClient().auth.getSession();
      if (!data.session || disposed) return;
      if (!registeredPushToken) {
        registeredPushToken = await registerRemotePushDevice();
      }
      socket?.disconnect();
      socket = io(`${baseUrl}/technician-events`, {
        auth: { accessToken: data.session.access_token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 10_000,
      });
      socket.on('technician:ready', refreshAssignments);
      socket.on('inspection:changed', (event: InspectionChangedEvent) => {
        refreshAssignments();
        void queryClient
          .invalidateQueries({ queryKey: queryKeys.inspection(event.inspectionId) })
          .catch(() => undefined);
        if (event.kind === 'ASSIGNED' && !registeredPushToken)
          void notifyNewAssignment(event.inspectionId).catch(() => undefined);
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
    const auth = getSupabaseClient().auth.onAuthStateChange((_event, session) => {
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
      auth.data.subscription.unsubscribe();
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
  try {
    const Notifications = await loadNotifications();
    if (!Notifications) return undefined;
    await configureNotifications(Notifications);
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return undefined;
    const projectId = resolveEasProjectId(
      Constants.easConfig?.projectId,
      (Constants.expoConfig?.extra?.eas as { projectId?: unknown } | undefined)?.projectId,
    );
    if (!projectId) return undefined;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await requestJson('/api/v1/technician/notification-devices', {
      method: 'POST',
      body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }),
    });
    await pushDeviceStorage.set(token);
    return token;
  } catch {
    return undefined;
  }
}

async function notifyNewAssignment(inspectionId: string) {
  const Notifications = await loadNotifications();
  if (!Notifications) return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'New inspection assigned',
      body: 'A new inspection is ready in your TexasRenters workspace.',
      data: { inspectionId },
      sound: true,
    },
    trigger: null,
  });
}
