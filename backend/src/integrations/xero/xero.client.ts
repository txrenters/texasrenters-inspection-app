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
 * What Xero objected to, from a refusal's validation errors: about the data
 * sent, never the sign-in (token errors are not read here). Trimmed, as it is
 * shown and stored.
 */
export function xeroValidationMessages(body: unknown): string | null {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.ValidationErrors))
      for (const error of record.ValidationErrors)
        if (error && typeof (error as { Message?: unknown }).Message === 'string') found.add((error as { Message: string }).Message.trim());
    for (const key of ['Elements', 'Invoices', 'Contacts', 'Payments']) visit(record[key], depth + 1);
  };
  visit(body, 0);
  const text = [...found].filter(Boolean).join(' ');
  return text ? text.slice(0, 500) : null;
}

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
    return this.call(organizationId, path, schema, { method: 'GET' });
  }

  /**
   * One write (phase 3), counted. Xero creates or updates what it is sent. The
   * idempotency key makes a retry of the same body -- after a timeout that hid
   * Xero's answer -- return the first answer instead of making a second copy.
   * A refused request says what Xero objected to.
   */
  async post<T>(organizationId: string, path: string, body: unknown, schema: z.ZodType<T>, idempotencyKey: string): Promise<T> {
    return this.call(organizationId, path, schema, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    });
  }

  private async call<T>(organizationId: string, path: string, schema: z.ZodType<T>, init: { method: string; body?: string; headers?: Record<string, string> }): Promise<T> {
    const connection = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { xeroTenantId: true } });
    if (!connection?.xeroTenantId) throw new XeroError('Xero is not connected.', 'XERO_NOT_CONNECTED', 409);
    const url = `${getXeroConfig().apiUrl}${path}`;
    let response = await this.counted(organizationId, async () => this.request(url, await this.auth.accessToken(organizationId), connection.xeroTenantId!, init));
    if (response.status === 401)
      response = await this.counted(organizationId, async () => this.request(url, await this.auth.refresh(organizationId), connection.xeroTenantId!, init));
    if (response.status === 400 && init.method !== 'GET') {
      const said = xeroValidationMessages(await response.json().catch(() => null));
      throw new XeroError(said ? `Xero refused it: ${said}` : 'Xero refused the request.', 'XERO_VALIDATION', 422, 400);
    }
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

  private request(url: string, token: string, tenantId: string, init: { method: string; body?: string; headers?: Record<string, string> }) {
    return this.fetch(url, {
      method: init.method,
      body: init.body,
      headers: { ...init.headers, authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId, accept: 'application/json' },
    });
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
