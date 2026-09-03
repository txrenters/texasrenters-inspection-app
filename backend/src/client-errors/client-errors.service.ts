import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientErrorSource } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import type { ReportClientErrorsDto } from './client-errors.dto';

/**
 * Strip anything credential-shaped, again, on the way in.
 *
 * The handset already redacts before it writes to its own log, and the console
 * redacts before it sends. This repeats both, because the endpoint is open to
 * anonymous callers: a client that skips redaction — an old build, a browser
 * extension, something nobody wrote — must not be able to put a live token in a
 * table that administrators read.
 *
 * Kept in step with `mobile/src/lib/error-log.ts`; the two have a test each
 * asserting the same shapes.
 */
export function redact(text: string): string {
  return (
    text
      .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[redacted-jwt]')
      // Scheme-prefixed values first, or "Authorization: Bearer <token>"
      // redacts the word "Bearer" and leaves the token.
      .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]')
      .replace(
        /\b(authorization|token|apikey|api_key|password|secret)\b\s*[:=]?\s*(?:bearer\s+|basic\s+)?\S+/gi,
        '$1 [redacted]',
      )
      .replace(/([?&](?:access_token|refresh_token|apikey|key)=)[^&\s]+/gi, '$1[redacted]')
  );
}

/**
 * How many reports one install may file in a window, and how wide the window is.
 *
 * A crash loop is the normal reason a client sends repeatedly, and it is the
 * one case where the client cannot be asked to behave. The deduplicating key
 * already makes a re-sent log free, so this only has to stop a caller
 * manufacturing *new* ids — which is the abuse case, not the failure case.
 */
const RATE_LIMIT = { requests: 12, windowMs: 60_000 } as const;

/** Kept small on purpose; it is a guard rail, not an audit trail. */
const RATE_LIMIT_MAX_TRACKED = 5_000;

@Injectable()
export class ClientErrorsService {
  private readonly logger = new Logger(ClientErrorsService.name);

  /**
   * In-memory, and therefore per-process and forgotten on restart.
   *
   * That is the right trade here rather than a Redis counter: the limit exists
   * to stop a table filling up, the cost of a restart is one extra window, and
   * a log endpoint that fails because Redis is unavailable would be dark
   * exactly when something is wrong.
   */
  private readonly recent = new Map<string, number[]>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private allow(key: string): boolean {
    const now = Date.now();
    const seen = (this.recent.get(key) ?? []).filter((at) => now - at < RATE_LIMIT.windowMs);
    if (seen.length >= RATE_LIMIT.requests) {
      this.recent.set(key, seen);
      return false;
    }
    seen.push(now);
    this.recent.set(key, seen);

    // Bounded so a stream of one-off install ids cannot grow this without end.
    if (this.recent.size > RATE_LIMIT_MAX_TRACKED) {
      for (const [entry, times] of this.recent) {
        if (times.every((at) => now - at >= RATE_LIMIT.windowMs)) this.recent.delete(entry);
        if (this.recent.size <= RATE_LIMIT_MAX_TRACKED) break;
      }
    }
    return true;
  }

  /**
   * Record what a client says went wrong.
   *
   * Returns how many entries were new. The flush is at-least-once — a client
   * re-sends anything it has not had acknowledged — so a duplicate is the
   * expected case and is not an error.
   */
  async report(
    body: ReportClientErrorsDto,
    caller: { organizationId?: string | null; authUserId?: string | null; ipAddress?: string },
  ): Promise<{ accepted: number; duplicates: number }> {
    // Keyed on the install rather than the address: technicians share office
    // Wi-Fi and a per-IP limit would let one looping handset silence the rest.
    // The address is the fallback for a caller that sends no install id.
    if (!this.allow(body.installId || (caller.ipAddress ?? 'unknown')))
      throw new ApplicationError(
        429,
        'TOO_MANY_ERROR_REPORTS',
        'Too many error reports from this client. Try again shortly.',
      );

    const rows: Prisma.ClientErrorReportCreateManyInput[] = body.entries.map((entry) => ({
      organizationId: caller.organizationId ?? null,
      authUserId: caller.authUserId ?? null,
      source: body.source === 'MOBILE' ? ClientErrorSource.MOBILE : ClientErrorSource.CONSOLE,
      clientEntryId: entry.id,
      installId: body.installId,
      message: redact(entry.message),
      stack: entry.stack ? redact(entry.stack) : null,
      context: entry.context ?? null,
      fatal: entry.fatal ?? false,
      platform: body.platform ?? null,
      appVersion: body.appVersion ?? null,
      buildId: body.buildId ?? null,
      apiBaseUrl: body.apiBaseUrl ?? null,
      // Trusted only as a claim. A phone with a wrong clock still sorts by
      // `receivedAt`, which is ours.
      occurredAt: new Date(entry.at),
    }));

    // `skipDuplicates` is the whole reason the unique pair exists: the client
    // does not have to track what was delivered, so a flush that fails halfway
    // simply happens again.
    const created = await this.prisma.clientErrorReport.createMany({
      data: rows,
      skipDuplicates: true,
    });

    if (created.count > 0)
      this.logger.log({
        event: 'client_errors_reported',
        source: body.source,
        accepted: created.count,
        installId: body.installId,
      });

    return { accepted: created.count, duplicates: rows.length - created.count };
  }

  /**
   * What the console shows.
   *
   * Deliberately not scoped to the caller's organization alone: an error raised
   * before sign-in has no organization at all, and those are the reports this
   * was built for. Reading them is gated on `system:manage`, which is the
   * operator permission, not a tenant one.
   */
  async list(query: {
    source?: 'MOBILE' | 'CONSOLE';
    fatalOnly?: boolean;
    search?: string;
    take?: number;
    cursor?: string;
  }) {
    const take = Math.min(Math.max(query.take ?? 50, 1), 200);
    const where: Prisma.ClientErrorReportWhereInput = {
      ...(query.source ? { source: query.source as ClientErrorSource } : {}),
      ...(query.fatalOnly ? { fatal: true } : {}),
      ...(query.search
        ? {
            OR: [
              { message: { contains: query.search, mode: 'insensitive' } },
              { context: { contains: query.search, mode: 'insensitive' } },
              { apiBaseUrl: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.clientErrorReport.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, take);
    return {
      items,
      // The id to continue from, or null at the end. Cursor rather than offset
      // because rows arrive constantly and an offset would repeat or skip.
      nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /** Counts for the header, so the page says whether anything is wrong at a glance. */
  async summary() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const [total, lastDay, fatalLastDay, mobileLastDay] = await Promise.all([
      this.prisma.clientErrorReport.count(),
      this.prisma.clientErrorReport.count({ where: { receivedAt: { gte: since } } }),
      this.prisma.clientErrorReport.count({ where: { receivedAt: { gte: since }, fatal: true } }),
      this.prisma.clientErrorReport.count({
        where: { receivedAt: { gte: since }, source: ClientErrorSource.MOBILE },
      }),
    ]);
    return { total, lastDay, fatalLastDay, mobileLastDay, consoleLastDay: lastDay - mobileLastDay };
  }
}
