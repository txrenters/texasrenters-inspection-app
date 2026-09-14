import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import {
  UserRole,
  type TechnicianPosition,
  type TechnicianPresenceEvent,
} from '@texasrenters/shared';
import type { Server, Socket } from 'socket.io';

import { authenticateApplicationUser, type AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { PresenceService } from './presence.service';
import { MobilePushService } from './mobile-push.service';

export type TechnicianInspectionEventKind =
  | 'ASSIGNED'
  | 'REASSIGNED'
  | 'UNASSIGNED'
  | 'CANCELLED'
  /** The office changed an inspection this technician is carrying -- more areas to walk. */
  | 'UPDATED'
  /**
   * The technician changed one of their own inspections.
   *
   * Sent so their other devices catch up, and never a notification. Their own
   * checklist taps, submits and skips used to go out as `UPDATED`, which pushed
   * "The office added an area to one of your inspections" back to the phone in
   * their hand after nearly every button they pressed.
   *
   * A kind of its own rather than a flag on `UPDATED` because the apps already
   * installed decide what to show by kind alone: they have no copy for this
   * one, so they refresh and stay silent without needing an update.
   */
  | 'SYNCED'
  /**
   * The office sent a submitted or finalized inspection back to this
   * technician, with a reason they need to read.
   */
  | 'REOPENED'
  /**
   * The office asked for more evidence in one of this technician's areas.
   *
   * A kind on the existing event rather than a new one: the client already
   * subscribes to `inspection:changed`, and a second channel would be a second
   * thing to keep connected, authorise and remember to handle.
   */
  | 'EVIDENCE_REQUESTED';

export interface TechnicianInspectionEvent {
  inspectionId: string;
  kind: TechnicianInspectionEventKind;
  occurredAt: string;
}

/**
 * A technician added an area on site, broadcast to the administrators watching
 * that organization.
 *
 * Carries enough to render a notification without a follow-up fetch. A toast
 * that says "an area was added" and forces someone to go looking is worse than
 * no toast: the whole point is that a property with no floor plan is gaining
 * its layout from the field, and the office wants to see it happening.
 */
/**
 * A thing that happened in the organization, addressed to its administrators.
 *
 * Distinct from the technician events above, which are addressed to one person.
 * `area:added` was the only broadcast of this kind and carried its own shape;
 * anything else the office needed to hear about — a technician submitting an
 * inspection, most obviously — had no channel at all, so the console stayed
 * silent and the office found out by reloading.
 *
 * `id` is the stored row's, so a console can match the live copy against the
 * list it loads on connecting. A socket that reconnects mid-flight can deliver
 * the same event twice, and a notification list that shows it twice reads as
 * two inspections submitted.
 */
export interface OrganizationNotification {
  id: string;
  kind: 'INSPECTION_SUBMITTED' | 'AREA_ADDED';
  title: string;
  body: string;
  /** Where the console should navigate when the notification is opened. */
  inspectionId: string;
  occurredAt: string;
}

export interface AreaAddedEvent {
  inspectionId: string;
  areaId: string;
  areaName: string;
  floorName: string | null;
  propertyName: string | null;
  technicianName: string;
  occurredAt: string;
}

type TechnicianSocket = Socket & { data: { user?: AuthenticatedUser } };

@Injectable()
@WebSocketGateway({ namespace: '/technician-events', transports: ['websocket'] })
export class TechnicianEventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server?: Server;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Optional() @Inject(MobilePushService) private readonly mobilePush?: MobilePushService,
  ) {}

  /**
   * Two audiences on one namespace, in rooms that never overlap.
   *
   * A technician joins only their own room and receives only their own
   * assignments. An administrator joins only the organization room and receives
   * what happens across it. Membership is derived from the authenticated user —
   * never from anything the client sends — so a technician cannot ask to watch
   * the organization, and neither can an administrator of another one.
   *
   * This used to reject every non-technician outright, which is why the web app
   * had no realtime at all.
   */
  async handleConnection(client: TechnicianSocket) {
    try {
      const token = this.accessToken(client);
      const user = await authenticateApplicationUser(this.prisma, token);
      if (user.mustChangePassword) throw new Error('A password change is required.');

      const isTechnician = user.roles.includes(UserRole.INSPECTION_TECHNICIAN);
      // The same permission the inspection list requires, so what a socket can
      // hear cannot exceed what the same account could already fetch.
      const watchesOrganization = user.permissions.includes('inspections:read');
      // Live positions are a **separate** room on a **separate** permission,
      // and the distinction is the whole point. The organization room is joined
      // on `inspections:read`; the map endpoint that serves these same
      // positions is gated on `technicians:locate`, because where a named person
      // was at a given minute is a fact about them rather than about an
      // inspection. Broadcasting positions to the organization room would hand
      // them to every account holding `inspections:read` and quietly undo that
      // boundary — so it gets its own room, joined on its own grant.
      const watchesLocations = user.permissions.includes('technicians:locate');
      if (!isTechnician && !watchesOrganization && !watchesLocations)
        throw new Error('No realtime audience.');

      /**
       * The socket may have closed while authentication was awaited.
       *
       * Its disconnect already ran, with no user on it, so it counted nothing;
       * counting it now would leave this person present until the API restarts.
       * A phone reconnecting on a refreshed token closes the socket it opened
       * milliseconds earlier, so this is not hypothetical.
       */
      if (client.disconnected) return;
      client.data.user = user;
      // Recorded after authentication and before joining any room: an
      // unauthenticated socket is not a person, and a person is present whether
      // or not they qualified for a room.
      const arrived = this.presence.connected(user.id);
      if (arrived && isTechnician) this.publishPresence(user, true);
      if (isTechnician) await client.join(this.technicianRoom(user.id));
      if (watchesOrganization) await client.join(this.organizationRoom(user.organizationId));
      if (watchesLocations) await client.join(this.locationRoom(user.organizationId));
      client.emit('technician:ready', { connectedAt: new Date().toISOString() });
    } catch {
      client.emit('technician:error', { message: 'Realtime authentication failed.' });
      client.disconnect(true);
    }
  }

  /**
   * A socket closing is the only signal that someone stopped listening.
   *
   * The gateway had no disconnect handler at all, so nothing knew when anyone
   * went away — which is why presence needed adding rather than reading.
   *
   * Keyed off `client.data.user`, so a socket that failed authentication and was
   * disconnected in `handleConnection` decrements nothing: it was never counted.
   */
  handleDisconnect(client: TechnicianSocket) {
    const user = client.data.user;
    if (!user) return;
    const left = this.presence.disconnected(user.id);
    if (left && user.roles.includes(UserRole.INSPECTION_TECHNICIAN)) this.publishPresence(user, false);
  }

  /**
   * Tell every console watching the map that a technician's app opened or closed.
   *
   * Only on the first socket opening and the last one closing: a phone holding
   * two connections is not "online twice". To the location room, because
   * whether a named person has the app open belongs with where they are.
   */
  private publishPresence(user: AuthenticatedUser, connected: boolean) {
    this.server?.to(this.locationRoom(user.organizationId)).emit('technician:presence', {
      technicianId: user.id,
      connected,
      lastSeenAt: this.presence.presenceFor(user.id).lastSeenAt,
    } satisfies TechnicianPresenceEvent);
  }

  publish(technicianId: string, inspectionId: string, kind: TechnicianInspectionEventKind) {
    const event: TechnicianInspectionEvent = {
      inspectionId,
      kind,
      occurredAt: new Date().toISOString(),
    };
    this.server?.to(this.technicianRoom(technicianId)).emit('inspection:changed', event);
    // The service decides which kinds are worth a push; the gateway just tells
    // it what happened. Pushing only ASSIGNED was why a reopened inspection or
    // an evidence request reached nobody whose app was closed.
    void this.mobilePush?.send(kind, technicianId, inspectionId);
  }

  /** Broadcast to the organization's administrators, not to any technician. */
  publishAreaAdded(organizationId: string, event: Omit<AreaAddedEvent, 'occurredAt'>) {
    this.server
      ?.to(this.organizationRoom(organizationId))
      .emit('area:added', { ...event, occurredAt: new Date().toISOString() } satisfies AreaAddedEvent);
    // The bell's copy goes through the stored path like every other
    // notification, so an account that was not connected still sees it.
    const where = [event.propertyName, event.floorName].filter(Boolean).join(' · ');
    void this.publishOrganizationNotification(organizationId, {
      kind: 'AREA_ADDED',
      title: `New area: ${event.areaName}`,
      body: [where, `Added by ${event.technicianName}`].filter(Boolean).join(' · '),
      inspectionId: event.inspectionId,
    });
  }

  /**
   * Tells the organization's administrators, and keeps it for those not listening.
   *
   * `publishAreaAdded` still sends its own event as well: that one drives cache
   * invalidation keyed to its own payload, and folding the two would make every
   * notification carry fields only one of them uses.
   */
  publishOrganizationNotification(
    organizationId: string,
    event: Omit<OrganizationNotification, 'id' | 'occurredAt'>,
  ) {
    // Stored first, so the id the open consoles receive is the one every other
    // account loads later; the bell de-duplicates on it.
    return this.recordNotification(organizationId, event).then((stored) => {
      this.server?.to(this.organizationRoom(organizationId)).emit('notification', stored);
      return stored;
    });
  }

  /**
   * Keep a notification for the accounts that were not connected.
   *
   * Never fails the caller: the inspection is already submitted and the area
   * already saved, and the consoles that are open should still hear about it
   * even if the row could not be written.
   */
  private async recordNotification(
    organizationId: string,
    event: Omit<OrganizationNotification, 'id' | 'occurredAt'>,
  ): Promise<OrganizationNotification> {
    try {
      const row = await this.prisma.organizationNotification.create({
        data: {
          organizationId,
          kind: event.kind,
          title: event.title,
          body: event.body,
          inspectionId: event.inspectionId,
        },
        select: { id: true, createdAt: true },
      });
      return { ...event, id: row.id, occurredAt: row.createdAt.toISOString() };
    } catch {
      return { ...event, id: randomUUID(), occurredAt: new Date().toISOString() };
    }
  }

  private accessToken(client: Socket) {
    const token = client.handshake.auth?.accessToken;
    if (typeof token !== 'string' || token.length === 0) throw new Error('Missing access token.');
    return token;
  }

  /**
   * A technician's handset reported where it is.
   *
   * Carries the same `TechnicianPosition` the map already fetches over HTTP, so
   * the console can drop it straight into the cache it already holds rather
   * than reshaping a second, nearly identical payload.
   *
   * Fire-and-forget by design. A dropped position is replaced by the next one
   * seconds later, and the HTTP endpoint remains the source of truth — so this
   * never needs delivery guarantees, and the console keeps a slow poll for the
   * case where the socket has quietly gone away.
   */
  publishTechnicianPosition(organizationId: string, position: TechnicianPosition) {
    this.server?.to(this.locationRoom(organizationId)).emit('technician:position', position);
  }

  private technicianRoom(technicianId: string) {
    return `technician:${technicianId}`;
  }

  /** Positions only, and only for `technicians:locate`. See `handleConnection`. */
  private locationRoom(organizationId: string) {
    return `organization:${organizationId}:locations`;
  }

  private organizationRoom(organizationId: string) {
    return `organization:${organizationId}`;
  }
}
