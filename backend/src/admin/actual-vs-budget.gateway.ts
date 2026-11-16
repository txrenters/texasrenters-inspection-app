import { Inject, Injectable } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { RevenueLiveChange, RevenueLiveEditor } from '@texasrenters/shared';
import type { Server, Socket } from 'socket.io';

import { authenticateApplicationUser, type AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';

type LiveSocket = Socket & { data: { user?: AuthenticatedUser; view?: string | null; cell?: string | null } };

/** A sheet's name and a cell's, as the page sends them: short, and nothing that is not a name. */
const VIEW = /^[a-z-]{1,20}$/;
const CELL = /^[A-Za-z0-9:_-]{1,160}$/;

/**
 * Actual vs Budget, live (2026-11-17; the office: "we should make it real time
 * cause there are two roles and users who are going to constantly update it,
 * it should sync all the time like the spreadsheet").
 *
 * Everyone in an office with the page open is in one room. Every save is told
 * to the room as it is made, so each page reads the sheet it shows again; and
 * which cell each person is in is told too, so the others see it, as in a
 * shared workbook.
 *
 * Its own namespace, as the Group maker's: the audience is whoever may read
 * the money (`invoices:read`), not everyone who may read inspections. It only
 * ever tells. Every change arrives over HTTP, behind the same guards,
 * validation and permission as any other write, and is passed on from there
 * once it is saved; nothing a socket sends changes a figure.
 */
@Injectable()
@WebSocketGateway({ namespace: '/actual-vs-budget', transports: ['websocket'] })
export class ActualVsBudgetGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server?: Server;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async handleConnection(client: LiveSocket) {
    try {
      const token = client.handshake.auth?.accessToken;
      if (typeof token !== 'string' || !token) throw new Error('Missing access token.');
      const user = await authenticateApplicationUser(this.prisma, token);
      if (user.mustChangePassword || !user.permissions.includes('invoices:read')) throw new Error('Not this audience.');
      if (client.disconnected) return;
      client.data.user = user;
      client.data.view = null;
      client.data.cell = null;
      await client.join(room(user.organizationId));
      client.emit('ready', { connectedAt: new Date().toISOString() });
      await this.publishPresence(user.organizationId);
    } catch {
      client.emit('refused', { message: 'Live editing is not available to this account.' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: LiveSocket) {
    const user = client.data.user;
    if (user) void this.publishPresence(user.organizationId);
  }

  /** Which sheet this person is on, and which cell they are in -- or none. */
  @SubscribeMessage('focus')
  async focus(@ConnectedSocket() client: LiveSocket, @MessageBody() body: { view?: unknown; cell?: unknown }) {
    const user = client.data.user;
    if (!user) return;
    client.data.view = typeof body?.view === 'string' && VIEW.test(body.view) ? body.view : null;
    client.data.cell = typeof body?.cell === 'string' && CELL.test(body.cell) ? body.cell : null;
    await this.publishPresence(user.organizationId);
  }

  /** A save, to everyone in the office with the page open -- the one who made it too, whose other tabs read it again. */
  publishChange(organizationId: string, change: Omit<RevenueLiveChange, 'at'>) {
    this.server?.to(room(organizationId)).emit('changed', { ...change, at: new Date().toISOString() } satisfies RevenueLiveChange);
  }

  /** Who has the page open, one entry a person: the tab they last moved in. */
  private async publishPresence(organizationId: string) {
    if (!this.server) return;
    const sockets = (await this.server.in(room(organizationId)).fetchSockets()) as unknown as LiveSocket[];
    const editors = new Map<string, RevenueLiveEditor>();
    for (const socket of sockets) {
      const user = socket.data.user;
      if (!user) continue;
      const known = editors.get(user.id);
      editors.set(user.id, {
        userId: user.id,
        name: user.displayName,
        view: socket.data.view ?? known?.view ?? null,
        cell: socket.data.cell ?? known?.cell ?? null,
      });
    }
    this.server.to(room(organizationId)).emit('presence', { editors: [...editors.values()] });
  }
}

const room = (organizationId: string) => `actual-vs-budget:${organizationId}`;
