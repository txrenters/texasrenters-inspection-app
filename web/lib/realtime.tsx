'use client';

import {
  applyPresenceEvent,
  mergeLatestPosition,
  type TechnicianPosition,
  type TechnicianPresenceEvent,
} from '@texasrenters/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';

import { api } from './api';
import { useAuth } from './auth';
import { useNotifications } from './notifications';
import { keys } from './queries';
import { getSession } from './session';

/**
 * Anything the office should be told about. Mirrors `OrganizationNotification`
 * in the gateway.
 */
interface OrganizationNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  inspectionId: string;
  occurredAt: string;
}

/**
 * What the backend broadcasts to an organization when a technician adds an area
 * on site. Mirrors `AreaAddedEvent` in the gateway.
 */
interface AreaAddedEvent {
  inspectionId: string;
  areaId: string;
  areaName: string;
  floorName: string | null;
  propertyName: string | null;
  technicianName: string;
  occurredAt: string;
}

/**
 * How long to wait before connecting again after the server hung up.
 *
 * socket.io reconnects by itself after the network drops, but never after the
 * server closes the connection, and the gateway does exactly that when it is
 * offered a token that has expired. A laptop waking from sleep offered the
 * token the page had loaded with, was refused, and the console stayed deaf
 * until it was reloaded: no notifications, and every technician frozen at
 * whatever the map had last fetched. Given up after the last delay, because
 * an account the gateway refuses for good should not ask forever.
 */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Keeps the administrator workspace live.
 *
 * The gateway used to reject anyone without the technician role, so this side
 * never existed and the office learned about field activity by reloading. It
 * now puts an administrator in an `organization:<id>` room derived from their
 * authenticated profile.
 *
 * Two things happen per event, and both matter. The toast is how somebody
 * notices; the invalidation is what makes the page they are already looking at
 * agree with it. A notification whose screen still shows the old data is worse
 * than neither.
 */
export function AdminRealtimeProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  // Read through a ref so the socket effect does not depend on the store's
  // identity — a re-render on every arriving notification would otherwise tear
  // the connection down and rebuild it, dropping the next one.
  const pushRef = useRef(notifications?.push);
  pushRef.current = notifications?.push;
  const mergeRef = useRef(notifications?.merge);
  mergeRef.current = notifications?.merge;
  const accessToken = session?.accessToken ?? null;
  // Held in a ref so a re-render caused by the invalidations below cannot tear
  // down and rebuild the socket, which would drop events in a loop.
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
    if (!accessToken || !baseUrl) return;

    // Rebuilt whenever the session's token changes, so a refreshed token never
    // leaves an authenticated-as-nobody connection open.
    const socket = io(`${baseUrl}/technician-events`, {
      transports: ['websocket'],
      // Asked for on every attempt rather than captured once: a reconnect an
      // hour later must offer the token the session holds then, refreshed if
      // it has expired, not the one this page happened to load with.
      auth: (deliver) => {
        void getSession()
          .catch(() => null)
          .then((current) => deliver({ accessToken: current?.accessToken ?? accessToken }));
      },
    });
    socketRef.current = socket;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    /**
     * Connected, or connected again: catch up on what this console missed.
     *
     * Every account loads the organization's stored notifications, so each one
     * holds the same list whether or not it was open when they happened. And
     * the map is refetched, because a technician may have opened or closed the
     * app while nobody was listening here.
     */
    socket.on('technician:ready', () => {
      attempts = 0;
      void queryClient.invalidateQueries({ queryKey: keys.technicianLocations });
      void api<OrganizationNotification[]>('/api/v1/admin/notifications')
        .then((stored) => mergeRef.current?.(stored))
        // An account that may not read inspections has no list to load; the
        // bell simply stays as it is.
        .catch(() => undefined);
    });

    socket.on('disconnect', (reason) => {
      if (reason !== 'io server disconnect' || attempts >= RECONNECT_DELAYS_MS.length) return;
      const delay = RECONNECT_DELAYS_MS[attempts];
      attempts += 1;
      retry = setTimeout(() => socket.connect(), delay);
    });

    // The general channel: things the office should notice, kept in the bell so
    // they survive being missed. A toast alone is gone in four seconds, which is
    // no use to anyone who stepped away.
    socket.on('notification', (event: OrganizationNotification) => {
      pushRef.current?.(event);
      toast.info(event.title, { description: event.body });
      // The submitted inspection has to appear in the queue the notification
      // points at, or clicking through lands on a stale page.
      void queryClient.invalidateQueries({ queryKey: keys.inspection(event.inspectionId) });
      void queryClient.invalidateQueries({ queryKey: keys.inspectionsRoot });
    });

    /**
     * A technician moved.
     *
     * Written straight into the cache rather than invalidated. An invalidation
     * would refetch every technician's position to learn that one of them moved
     * a few metres, several times a minute, for as long as anybody has the map
     * open. The payload is already the exact row the query holds.
     *
     * No toast either — this is ambient. A technician walking a property would
     * otherwise bury every notification that actually needs reading.
     */
    socket.on('technician:position', (position: TechnicianPosition) => {
      queryClient.setQueryData<TechnicianPosition[]>(keys.technicianLocations, (current) =>
        // Undefined means the map has never loaded; there is no list to fold
        // into and the fetch on mount will bring a complete one.
        current ? mergeLatestPosition(current, position) : current,
      );
    });

    /**
     * A technician's app opened or closed.
     *
     * Written into the positions every console holds, the moment it happens.
     * Whether the app was open used to come only from each console's own last
     * fetch, minutes apart, so two accounts showed the same technician online
     * on one and offline on the other.
     */
    socket.on('technician:presence', (event: TechnicianPresenceEvent) => {
      queryClient.setQueryData<TechnicianPosition[]>(keys.technicianLocations, (current) =>
        current ? applyPresenceEvent(current, event) : current,
      );
    });

    socket.on('area:added', (event: AreaAddedEvent) => {
      // No toast and nothing for the bell here: the gateway sends this area as
      // a stored `notification` too, which is the copy every account shares.
      // Announcing it twice would read as two areas added.
      // The area lists, the evidence summary, and any list showing area counts.
      // Broad on purpose: an area appearing is rare, and a missed refresh is a
      // stale screen next to a toast that says it changed.
      void queryClient.invalidateQueries({ queryKey: keys.inspection(event.inspectionId) });
      void queryClient.invalidateQueries({ queryKey: keys.inspectionAreas(event.inspectionId) });
      void queryClient.invalidateQueries({
        queryKey: keys.areaEvidenceSummary(event.inspectionId),
      });
      void queryClient.invalidateQueries({ queryKey: keys.inspectionsRoot });
    });

    // Deliberately quiet. A dropped websocket is ordinary — a laptop lid, a
    // tunnel restart — and socket.io reconnects on its own. Announcing it would
    // train people to ignore the toasts that matter.
    socket.on('technician:error', () => undefined);

    return () => {
      clearTimeout(retry);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken, queryClient]);

  return <>{children}</>;
}
