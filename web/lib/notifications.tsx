'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/** One thing the office should know about. Mirrors the gateway's payload. */
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  inspectionId: string;
  occurredAt: string;
  read: boolean;
}

interface NotificationsValue {
  notifications: AppNotification[];
  unreadCount: number;
  /** Adds one, deduplicating by id. */
  push: (notification: Omit<AppNotification, 'read'>) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
  /** null until the browser has been asked, then 'granted' | 'denied' | 'default'. */
  permission: NotificationPermission | null;
  requestPermission: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

/**
 * How many are kept. Beyond this the list stops being something anyone reads,
 * and the oldest are the least likely to still matter.
 */
const MAX_NOTIFICATIONS = 50;

/** Where the list is persisted, so a page reload does not lose what arrived. */
const STORAGE_KEY = 'texasrenters.notifications';

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /**
   * Suppresses the sound and the desktop toast for the first paint.
   *
   * Notifications are restored from storage on mount, and replaying a chime for
   * things that arrived yesterday teaches people to ignore it.
   */
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setNotifications(JSON.parse(stored) as AppNotification[]);
    } catch {
      // A corrupt or unavailable store is not worth failing the app over —
      // the list simply starts empty.
    }
    if ('Notification' in window) setPermission(Notification.permission);
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
    } catch {
      // Quota or private mode. The in-memory list still works for this session.
    }
  }, [notifications]);

  const requestPermission = useCallback(() => {
    if (!('Notification' in window)) return;
    void Notification.requestPermission().then(setPermission);
  }, []);

  const push = useCallback((incoming: Omit<AppNotification, 'read'>) => {
    let isNew = false;
    setNotifications((current) => {
      // Deduplicated by id: a socket that reconnects mid-flight can deliver the
      // same event twice, and two rows reads as two inspections submitted.
      if (current.some((existing) => existing.id === incoming.id)) return current;
      isNew = true;
      return [{ ...incoming, read: false }, ...current].slice(0, MAX_NOTIFICATIONS);
    });
    if (!isNew) return;

    // Sound. Rebuilt per play so overlapping arrivals do not cut each other off,
    // and deliberately swallowed on failure: browsers block audio until the page
    // has been interacted with, and an unplayable chime must not break the
    // notification itself.
    try {
      const audio = audioRef.current ?? new Audio('/notification.mp3');
      audioRef.current = audio;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    } catch {
      // No audio support. The badge and the desktop notification still land.
    }

    // Desktop notification, for the case this all exists to serve: nobody is
    // looking at the tab. Guarded on permission rather than requested here —
    // a permission prompt fired by a background event, with no explanation on
    // screen, is the kind people deny once and forever.
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(incoming.title, {
          body: incoming.body,
          tag: incoming.id,
          icon: '/texasrenterslogo-transparent.png',
        });
        notification.onclick = () => {
          window.focus();
          window.location.href = `/inspections/${incoming.inspectionId}`;
        };
      }
    } catch {
      // Unsupported or blocked. Not worth surfacing.
    }
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
  }, []);

  const remove = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  const value = useMemo<NotificationsValue>(
    () => ({
      notifications,
      unreadCount: notifications.filter((item) => !item.read).length,
      push,
      markAllRead,
      remove,
      clear,
      permission,
      requestPermission,
    }),
    [notifications, push, markAllRead, remove, clear, permission, requestPermission],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/**
 * Returns null outside the provider rather than throwing.
 *
 * The header renders in layouts that some tests and the public report route
 * mount without the admin providers, and a bell that quietly renders nothing is
 * a better failure than a crashed page.
 */
export function useNotifications() {
  return useContext(NotificationsContext);
}
