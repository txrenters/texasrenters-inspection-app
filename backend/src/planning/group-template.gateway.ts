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
import type { GroupTemplateEditor, GroupTemplateOpsEvent } from '@texasrenters/shared';
import type { Server, Socket } from 'socket.io';

import { authenticateApplicationUser, type AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { withTenant } from '../database/tenant-context';

type TemplateSocket = Socket & { data: { user?: AuthenticatedUser; templateId?: string; groupId?: string | null } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a live template reloaded rather than applied a batch: somebody replaced or archived it. */
export interface GroupTemplateReplacedEvent {
  templateId: string;
  revision: number;
  reason: 'SAVED' | 'ARCHIVED' | 'ACTIVATED';
  by: { userId: string; name: string };
}

/**
 * Live group templates (the office, 2026-10-01): everyone with one template
 * open in the Group maker hears every change to it as it is made, and who else
 * has it open.
 *
 * Its own namespace rather than the technician events', because its audience
 * is different -- `planning:read`, not `inspections:read` -- and a room here
 * is a template somebody opened, joined by asking, where a room there is a
 * fact about who the account is.
 *
 * Only ever tells. Every change arrives over HTTP (`POST
 * group-templates/:id/ops`), behind the same guards, validation and
 * permission as any other write, and is passed on from there once it is
 * saved. Nothing a socket sends changes a template.
 */
@Injectable()
@WebSocketGateway({ namespace: '/group-templates', transports: ['websocket'] })
export class GroupTemplateGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server?: Server;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async handleConnection(client: TemplateSocket) {
    try {
      const token = client.handshake.auth?.accessToken;
      if (typeof token !== 'string' || !token) throw new Error('Missing access token.');
      const user = await authenticateApplicationUser(this.prisma, token);
      if (user.mustChangePassword || !user.permissions.includes('planning:read')) throw new Error('No template audience.');
      if (client.disconnected) return;
      client.data.user = user;
      client.emit('ready', { connectedAt: new Date().toISOString() });
    } catch {
      client.emit('refused', { message: 'Live editing is not available to this account.' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: TemplateSocket) {
    const templateId = client.data.templateId;
    if (templateId) void this.publishPresence(templateId);
  }

  /**
   * Open a template live: its changes and who else has it open.
   *
   * Only a template of the account's own organization, looked up with the
   * account's own organization -- never one the client names from another.
   * One template per socket; opening another leaves the first.
   */
  @SubscribeMessage('join')
  async join(@ConnectedSocket() client: TemplateSocket, @MessageBody() body: { templateId?: unknown }) {
    const user = client.data.user;
    const templateId = typeof body?.templateId === 'string' ? body.templateId : '';
    if (!user || !UUID.test(templateId)) return { ok: false };
    const template = await withTenant(user.organizationId, () =>
      this.prisma.tbpGroupTemplate.findFirst({
        where: { id: templateId, organizationId: user.organizationId },
        select: { id: true, revision: true },
      }),
    );
    if (!template) return { ok: false };
    const previous = client.data.templateId;
    if (previous && previous !== templateId) {
      await client.leave(room(previous));
      client.data.templateId = undefined;
      await this.publishPresence(previous);
    }
    client.data.templateId = templateId;
    client.data.groupId = null;
    await client.join(room(templateId));
    await this.publishPresence(templateId);
    return { ok: true, revision: template.revision };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() client: TemplateSocket) {
    const templateId = client.data.templateId;
    if (!templateId) return;
    client.data.templateId = undefined;
    await client.leave(room(templateId));
    await this.publishPresence(templateId);
  }

  /** Which group this person is building now, so the others can see it. */
  @SubscribeMessage('focus')
  async focus(@ConnectedSocket() client: TemplateSocket, @MessageBody() body: { groupId?: unknown }) {
    const templateId = client.data.templateId;
    if (!templateId) return;
    client.data.groupId = typeof body?.groupId === 'string' && UUID.test(body.groupId) ? body.groupId : null;
    await this.publishPresence(templateId);
  }

  /** A batch the service just saved, to everyone with the template open -- its sender too, who waits for it. */
  publishOps(event: GroupTemplateOpsEvent) {
    this.server?.to(room(event.templateId)).emit('ops', event);
  }

  /** The template was replaced whole or archived: everyone with it open reads it again. */
  publishReplaced(event: GroupTemplateReplacedEvent) {
    this.server?.to(room(event.templateId)).emit('replaced', event);
  }

  /** Who has the template open, one entry a person however many tabs they have. */
  private async publishPresence(templateId: string) {
    if (!this.server) return;
    const sockets = (await this.server.in(room(templateId)).fetchSockets()) as unknown as TemplateSocket[];
    const editors = new Map<string, GroupTemplateEditor>();
    for (const socket of sockets) {
      const user = socket.data.user;
      if (!user) continue;
      const known = editors.get(user.id);
      editors.set(user.id, {
        userId: user.id,
        name: user.displayName,
        groupId: socket.data.groupId ?? known?.groupId ?? null,
      });
    }
    this.server.to(room(templateId)).emit('presence', { templateId, editors: [...editors.values()] });
  }
}

const room = (templateId: string) => `group-template:${templateId}`;
