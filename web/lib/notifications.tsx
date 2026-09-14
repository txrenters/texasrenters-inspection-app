'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from './auth';

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
  /**
   * Folds in the organization's stored list: whatever this account has not got
   * yet, quietly. History must not chime or raise a desktop alert.
   */
  merge: (notifications: Omit<AppNotification, 'read'>[]) => void;
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

/**
 * Where the list is persisted, so a page reload does not lose what arrived.
 *
 * One list per account. Which notifications have been read is a person's own
 * state, and two accounts signed in on one browser used to share a single
 * list, reading and clearing each other's.
 */
const storageKeyFor = (account: string) => `texasrenters.notifications:${account}`;

/**
 * What the account removed or cleared.
 *
 * Every console loads the organization's stored list when it connects, so
 * without this a cleared bell filled up again on the next page load.
 */
const dismissedKeyFor = (account: string) => `texasrenters.notifications:${account}:dismissed`;

/** Far more than the fifty the server sends back, so nothing dismissed returns. */
const MAX_DISMISSED = 200;

/** The one shared list from before, adopted by the first account to load. */
const LEGACY_STORAGE_KEY = 'texasrenters.notifications';

function readStored<T>(key: string, legacyKey?: string): T[] {
  try {
    const own = window.localStorage.getItem(key);
    if (own) return JSON.parse(own) as T[];
    if (!legacyKey) return [];
    const legacy = window.localStorage.getItem(legacyKey);
    window.localStorage.removeItem(legacyKey);
    return legacy ? (JSON.parse(legacy) as T[]) : [];
  } catch {
    // A corrupt or unavailable store is not worth failing the app over —
    // the list simply starts empty.
    return [];
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode. The in-memory list still works for this session.
  }
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const account = session?.authUserId ?? null;
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  /**
   * Whose list `notifications` holds.
   *
   * State rather than a ref, so it changes in the same render as the list. A
   * write can then never file one account's list under another's key in the
   * render between switching accounts and loading the new list.
   */
  const [owner, setOwner] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /**
   * Every id this account holds, has announced or has dismissed.
   *
   * Checked synchronously. Whether a notification was new used to be learned
   * inside the state updater, but React runs an updater during the next
   * render once the provider has rendered an update, which is after the
   * sound and the desktop alert had already been skipped as "not new".
   */
  const known = useRef(new Set<string>());
  const dismissed = useRef<string[]>([]);

  useEffect(() => {
    const stored = account ? readStored<AppNotification>(storageKeyFor(account), LEGACY_STORAGE_KEY) : [];
    dismissed.current = account ? readStored<string>(dismissedKeyFor(account)) : [];
    known.current = new Set([...stored.map((item) => item.id), ...dismissed.current]);
    setNotifications(stored);
    setOwner(account);
    if ('Notification' in window) setPermission(Notification.permission);
  }, [account]);

  useEffect(() => {
    if (!account || owner !== account) return;
    writeStored(storageKeyFor(account), notifications);
  }, [account, owner, notifications]);

  const dismiss = useCallback(
    (ids: string[]) => {
      if (!account || !ids.length) return;
      const leaving = new Set(ids);
      dismissed.current = [...ids, ...dismissed.current.filter((id) => !leaving.has(id))].slice(
        0,
        MAX_DISMISSED,
      );
      writeStored(dismissedKeyFor(account), dismissed.current);
    },
    [account],
  );

  const requestPermission = useCallback(() => {
    if (!('Notification' in window)) return;
    void Notification.requestPermission().then(setPermission);
  }, []);

  const push = useCallback((incoming: Omit<AppNotification, 'read'>) => {
    // Deduplicated by id: a socket that reconnects mid-flight can deliver the
    // same event twice, and two rows reads as two inspections submitted.
    if (known.current.has(incoming.id)) return;
    known.current.add(incoming.id);
    setNotifications((current) =>
      current.some((existing) => existing.id === incoming.id)
        ? current
        : [{ ...incoming, read: false }, ...current].slice(0, MAX_NOTIFICATIONS),
    );

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

  const merge = useCallback((incoming: Omit<AppNotification, 'read'>[]) => {
    const unseen = incoming.filter((item) => !known.current.has(item.id));
    if (!unseen.length) return;
    for (const item of unseen) known.current.add(item.id);
    setNotifications((current) => {
      const listed = new Set(current.map((item) => item.id));
      const additions = unseen
        .filter((item) => !listed.has(item.id))
        .map((item) => ({ ...item, read: false }));
      if (!additions.length) return current;
      return [...additions, ...current]
        .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
        .slice(0, MAX_NOTIFICATIONS);
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
  }, []);

  const remove = useCallback(
    (id: string) => {
      dismiss([id]);
      setNotifications((current) => current.filter((item) => item.id !== id));
    },
    [dismiss],
  );

  const clear = useCallback(() => {
    // Everything this account has held, not only what is on screen: anything
    // that fell off the end must not come back either.
    dismiss([...known.current]);
    setNotifications([]);
  }, [dismiss]);

  const value = useMemo<NotificationsValue>(
    () => ({
      notifications,
      unreadCount: notifications.filter((item) => !item.read).length,
      push,
      merge,
      markAllRead,
      remove,
      clear,
      permission,
      requestPermission,
    }),
    [notifications, push, merge, markAllRead, remove, clear, permission, requestPermission],
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
