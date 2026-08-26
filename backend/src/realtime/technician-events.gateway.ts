import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { OnGatewayConnection } from '@nestjs/websockets';
import { UserRole, type TechnicianPosition } from '@texasrenters/shared';
import type { Server, Socket } from 'socket.io';

import { authenticateApplicationUser, type AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { MobilePushService } from './mobile-push.service';

export type TechnicianInspectionEventKind =
  | 'ASSIGNED'
  | 'REASSIGNED'
  | 'UNASSIGNED'
  | 'CANCELLED'
  | 'UPDATED'
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
 * `id` is generated at the source so the console can deduplicate. A socket that
 * reconnects mid-flight can deliver the same event twice, and a notification
 * list that shows it twice reads as two inspections submitted.
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
export class TechnicianEventsGateway implements OnGatewayConnection {
  @WebSocketServer() private server?: Server;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
      // positions is gated on `technicians:read`, because where a named person
      // was at a given minute is a fact about them rather than about an
      // inspection. Broadcasting positions to the organization room would hand
      // them to every account holding `inspections:read` and quietly undo that
      // boundary — so it gets its own room, joined on its own grant.
      const watchesLocations = user.permissions.includes('technicians:read');
      if (!isTechnician && !watchesOrganization && !watchesLocations)
        throw new Error('No realtime audience.');

      client.data.user = user;
      if (isTechnician) await client.join(this.technicianRoom(user.id));
      if (watchesOrganization) await client.join(this.organizationRoom(user.organizationId));
      if (watchesLocations) await client.join(this.locationRoom(user.organizationId));
      client.emit('technician:ready', { connectedAt: new Date().toISOString() });
    } catch {
      client.emit('technician:error', { message: 'Realtime authentication failed.' });
      client.disconnect(true);
    }
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
  }

  /**
   * Broadcasts a notification to the organization's administrators.
   *
   * Separate from publishAreaAdded, which stays as it is: that event also drives
   * cache invalidation keyed to its own payload, and folding the two would make
   * every notification carry fields only one of them uses.
   */
  publishOrganizationNotification(
    organizationId: string,
    event: Omit<OrganizationNotification, 'id' | 'occurredAt'>,
  ) {
    this.server?.to(this.organizationRoom(organizationId)).emit('notification', {
      ...event,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    } satisfies OrganizationNotification);
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

  /** Positions only, and only for `technicians:read`. See `handleConnection`. */
  private locationRoom(organizationId: string) {
    return `organization:${organizationId}:locations`;
  }

  private organizationRoom(organizationId: string) {
    return `organization:${organizationId}`;
  }
}
