import { Inject, Injectable, Optional } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { OnGatewayConnection } from '@nestjs/websockets';
import { UserRole } from '@texasrenters/shared';
import type { Server, Socket } from 'socket.io';

import { authenticateApplicationUser, type AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { MobilePushService } from './mobile-push.service';

export type TechnicianInspectionEventKind =
  'ASSIGNED' | 'REASSIGNED' | 'UNASSIGNED' | 'CANCELLED' | 'UPDATED';

export interface TechnicianInspectionEvent {
  inspectionId: string;
  kind: TechnicianInspectionEventKind;
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

  async handleConnection(client: TechnicianSocket) {
    try {
      const token = this.accessToken(client);
      const user = await authenticateApplicationUser(this.prisma, token);
      if (user.mustChangePassword || !user.roles.includes(UserRole.INSPECTION_TECHNICIAN)) {
        throw new Error('Technician access is required.');
      }
      client.data.user = user;
      await client.join(this.room(user.id));
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
    this.server?.to(this.room(technicianId)).emit('inspection:changed', event);
    if (kind === 'ASSIGNED') void this.mobilePush?.sendAssignment(technicianId, inspectionId);
  }

  private accessToken(client: Socket) {
    const token = client.handshake.auth?.accessToken;
    if (typeof token !== 'string' || token.length === 0) throw new Error('Missing access token.');
    return token;
  }

  private room(technicianId: string) {
    return `technician:${technicianId}`;
  }
}
