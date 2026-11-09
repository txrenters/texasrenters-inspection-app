import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { XeroAuthService } from './xero-auth.service';
import { getXeroConfig } from './xero.config';
import { XeroError } from './xero.errors';

const connectionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantType: z.string(),
  tenantName: z.string().nullable().optional(),
  authEventId: z.string().nullable().optional(),
});
export type XeroTenantConnection = z.infer<typeof connectionSchema>;

/**
 * Every call to Xero's API (2026-11-10), for one office's organisation.
 *
 * Xero allows an organisation 60 calls a minute and, on its free tier, 1,000 a
 * day. Each call is counted before it is made against the console's own lower
 * ceiling (`XERO_DAILY_CALL_CEILING`, 300), in the database so a restart does
 * not reset it; past it, nothing is asked of Xero until the next Texas day. A
 * 429 is reported with Xero's wait, never retried in a loop.
 */
@Injectable()
export class XeroClient {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroAuthService) private readonly auth: XeroAuthService,
  ) {}

  /** The organisations a fresh token reaches. Before anything is stored, so it is not counted. */
  async connections(accessToken: string): Promise<XeroTenantConnection[]> {
    const config = getXeroConfig();
    const response = await this.fetch(config.connectionsUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    if (!response.ok) throw this.failure(response);
    const parsed = z.array(connectionSchema).safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new XeroError('Xero did not say which organisation was chosen.', 'XERO_UNEXPECTED_RESPONSE', 502);
    return parsed.data;
  }

  /** One read of the organisation's data, counted, with the token refreshed once if Xero says it is stale. */
  async get<T>(organizationId: string, path: string, schema: z.ZodType<T>): Promise<T> {
    const connection = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { xeroTenantId: true } });
    if (!connection?.xeroTenantId) throw new XeroError('Xero is not connected.', 'XERO_NOT_CONNECTED', 409);
    const url = `${getXeroConfig().apiUrl}${path}`;
    let response = await this.counted(organizationId, async () => this.request(url, await this.auth.accessToken(organizationId), connection.xeroTenantId!));
    if (response.status === 401)
      response = await this.counted(organizationId, async () => this.request(url, await this.auth.refresh(organizationId), connection.xeroTenantId!));
    if (!response.ok) throw this.failure(response);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new XeroError('Xero did not answer as expected.', 'XERO_UNEXPECTED_RESPONSE', 502);
    return parsed.data;
  }

  /** Ends this app's link to the organisation at Xero. */
  async removeConnection(accessToken: string, connectionId: string) {
    const response = await this.fetch(`${getXeroConfig().connectionsUrl}/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return response.ok || response.status === 404;
  }

  /** Calls left today, and the ceiling. */
  async allowance(organizationId: string) {
    const ceiling = getXeroConfig().dailyCallCeiling;
    const row = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { callsDay: true, callsUsed: true } });
    return { used: row?.callsDay === businessDate() ? row.callsUsed : 0, ceiling };
  }

  private async counted(organizationId: string, call: () => Promise<Response>) {
    const today = businessDate();
    const ceiling = getXeroConfig().dailyCallCeiling;
    // Two single-statement updates: a new day starts the count at one; otherwise one more, while under the ceiling.
    const fresh = await this.prisma.xeroConnection.updateMany({
      where: { organizationId, OR: [{ callsDay: null }, { callsDay: { not: today } }] },
      data: { callsDay: today, callsUsed: 1 },
    });
    if (!fresh.count) {
      const more = await this.prisma.xeroConnection.updateMany({
        where: { organizationId, callsDay: today, callsUsed: { lt: ceiling } },
        data: { callsUsed: { increment: 1 } },
      });
      if (!more.count)
        throw new XeroError(`The console has used its ${ceiling} calls to Xero today. More can go tomorrow.`, 'XERO_DAILY_CEILING', 429);
    }
    return call();
  }

  private request(url: string, token: string, tenantId: string) {
    return this.fetch(url, { headers: { authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId, accept: 'application/json' } });
  }

  private async fetch(url: string, init: RequestInit) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(getXeroConfig().requestTimeoutMs) });
    } catch {
      throw new XeroError('Xero could not be reached. Try again in a moment.', 'XERO_UNREACHABLE', 502);
    }
  }

  /** What went wrong, in our words; Xero's own body is never passed on. */
  private failure(response: Response) {
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after'));
      return new XeroError(
        `Xero asked the console to slow down${Number.isFinite(wait) && wait > 0 ? `; try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}` : ''}.`,
        'XERO_RATE_LIMITED',
        429,
        429,
      );
    }
    if (response.status === 401) return new XeroError('Xero refused the stored sign-in. Connect again.', 'XERO_REAUTHORIZATION_REQUIRED', 409, 401);
    if (response.status === 403) return new XeroError('Xero did not allow that: the connection lacks the permission.', 'XERO_FORBIDDEN', 502, 403);
    return new XeroError('Xero did not answer as expected.', 'XERO_UNEXPECTED_RESPONSE', 502, response.status);
  }
}
