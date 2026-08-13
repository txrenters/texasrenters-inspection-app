'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';

import { useAuth } from './auth';
import { useNotifications } from './notifications';
import { keys } from './queries';

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
  const accessToken = session?.accessToken ?? null;
  // Held in a ref so a re-render caused by the invalidations below cannot tear
  // down and rebuild the socket, which would drop events in a loop.
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
    if (!accessToken || !baseUrl) return;

    // The token is captured at connect, so the socket is rebuilt whenever it
    // changes — a refreshed token must not leave an authenticated-as-nobody
    // connection open.
    const socket = io(`${baseUrl}/technician-events`, {
      transports: ['websocket'],
      auth: { accessToken },
    });
    socketRef.current = socket;

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

    socket.on('area:added', (event: AreaAddedEvent) => {
      const where = [event.propertyName, event.floorName].filter(Boolean).join(' · ');
      // Separated with a middot rather than an em-dash. The em-dash is banned in
      // shipped copy (skill Section 9.G); it also reads as a sentence break here
      // when the two halves are really just adjacent facts.
      const description = [where, `Added by ${event.technicianName}`].filter(Boolean).join(' · ');
      toast.info(`New area: ${event.areaName}`, { description });
      pushRef.current?.({
        // The gateway does not id this event, so it is keyed by what makes it
        // unique: one area is added once.
        id: `area:${event.areaId}`,
        kind: 'AREA_ADDED',
        title: `New area: ${event.areaName}`,
        body: description,
        inspectionId: event.inspectionId,
        occurredAt: event.occurredAt,
      });
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
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken, queryClient]);

  return <>{children}</>;
}
