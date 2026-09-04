import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  PROPERTYWARE_AUTH_HEADERS,
  PROPERTYWARE_ENDPOINTS,
  type PropertywareEntity,
} from './propertyware.constants';
import { PropertywareError, sanitizedProviderMessage } from './propertyware.errors';
import { getPropertywareConfig } from './propertyware.config';
import {
  leaseReportColumns,
  propertywareLeaseReportSchema,
  propertywarePortfolioReportSchema,
  propertywareSchemas,
} from './propertyware.schemas';
import type { PropertywarePage, PropertywarePageQuery } from './propertyware.types';

/** Report dates arrive as MM/DD/YYYY; the rest of the pipeline expects ISO. */
export function reportDate(value: string | undefined): string | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((value ?? '').trim());
  if (!match) return undefined;
  const [, month, day, year] = match;
  return `${year}-${month}-${day}`;
}

/**
 * Stable identity for a lease that the report does not identify. Derived from
 * values Propertyware owns, so it is reproducible across syncs; prefixed so it
 * can never be mistaken for — or collide with — a REST lease ID.
 */
export function leaseReportExternalId(
  buildingExternalId: string,
  leaseName: string,
  startDate: string,
) {
  const digest = createHash('sha256')
    .update(`${buildingExternalId}|${leaseName}|${startDate}`)
    .digest('hex')
    .slice(0, 12);
  return `rpt-${buildingExternalId}-${digest}`;
}

@Injectable()
export class PropertywareClient {
  private readonly logger = new Logger(PropertywareClient.name);
  private readonly config = getPropertywareConfig();

  /**
   * Buildings by address, when the caller has loaded them.
   *
   * Set for the duration of a sync run rather than injected, because this is a
   * plain HTTP client with no database of its own and resolving an address
   * needs one. Left undefined outside a run, in which case a report that
   * identifies buildings only by address simply yields no leases -- the same
   * answer it gave before this existed.
   */
  private buildingAddresses?: { resolve(address: string, postalCode?: string): string | null };

  useBuildingAddresses(index: { resolve(address: string, postalCode?: string): string | null }) {
    this.buildingAddresses = index;
  }

  async fetchPage(entity: PropertywareEntity, query: PropertywarePageQuery, correlationId: string) {
    const offset = query.offset ?? 0;
    const limit = Math.min(query.limit ?? this.config.pageSize, this.config.pageSize);
    const url = new URL(`${this.config.baseUrl}${PROPERTYWARE_ENDPOINTS[entity]}`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    if (query.lastModifiedDateTimeStart)
      url.searchParams.set('lastModifiedDateTimeStart', query.lastModifiedDateTimeStart);
    if (query.lastModifiedDateTimeEnd)
      url.searchParams.set('lastModifiedDateTimeEnd', query.lastModifiedDateTimeEnd);
    if (query.includeDeactivated !== undefined && entity !== 'leases')
      url.searchParams.set('includeDeactivated', String(query.includeDeactivated));
    url.searchParams.set('includeCustomFields', 'false');

    let response: Awaited<ReturnType<PropertywareClient['request']>>;
    try {
      response = await this.request(url, correlationId);
    } catch (error) {
      // A denied REST endpoint falls back to a published report when one is
      // configured, so a missing module permission degrades rather than fails.
      if (error instanceof PropertywareError && error.status === 403) {
        if (entity === 'portfolios' && this.config.portfolioReportUrl)
          return this.fetchPortfolioReportPage(query, correlationId);
        if (entity === 'leases' && this.config.leaseReportUrl) {
          this.logger.warn({
            event: 'propertyware_lease_report_fallback',
            correlationId,
            reason: 'REST /leases denied; using the configured published report.',
          });
          return this.fetchLeaseReportPage(query, correlationId);
        }
      }
      throw error;
    }
    const { payload, headers } = response;
    if (!Array.isArray(payload))
      throw new PropertywareError(
        'Propertyware returned an unexpected page shape.',
        'PROPERTYWARE_INVALID_PAGE',
      );
    const schema = propertywareSchemas[entity];
    const validationErrors: NonNullable<PropertywarePage<unknown>['validationErrors']> = [];
    const records = payload.flatMap((record, index) => {
      const parsed = schema.safeParse(record);
      if (!parsed.success) {
        const externalId =
          record && typeof record === 'object' && 'id' in record
            ? String((record as { id: unknown }).id)
            : undefined;
        validationErrors.push({
          index,
          externalId,
          code: 'PROPERTYWARE_SCHEMA_ERROR',
          detail: summarizeSchemaIssues(parsed.error),
        });
        return [];
      }
      if (query.includeDeactivated !== true && parsed.data.active !== true) return [];
      return [parsed.data];
    });
    const total = headers.get('x-total-count');
    return {
      records,
      receivedCount: payload.length,
      validationErrors,
      totalCount: total == null ? undefined : Number(total),
      offset,
      limit,
    } as PropertywarePage<(typeof records)[number]>;
  }

  async fetchOne(entity: PropertywareEntity, externalId: string, correlationId: string) {
    const url = new URL(
      `${this.config.baseUrl}${PROPERTYWARE_ENDPOINTS[entity]}/${encodeURIComponent(externalId)}`,
    );
    const { payload } = await this.request(url, correlationId);
    const parsed = propertywareSchemas[entity].safeParse(payload);
    if (!parsed.success)
      throw new PropertywareError(
        `Propertyware ${entity} detail failed validation.`,
        'PROPERTYWARE_SCHEMA_ERROR',
      );
    return parsed.data;
  }

  /**
   * Lease rows from a published Propertyware report, used when the REST
   * `/leases` endpoint is not permitted for this integration.
   *
   * The report carries no lease ID and no unit, only building-level columns, so
   * each lease is keyed by a deterministic hash of building + lease name +
   * start date. That is a natural key drawn from real Propertyware values, not
   * an invented one: re-running the sync produces the same key, so records
   * update rather than duplicate. A lease renamed or re-dated upstream will key
   * differently and appear as a new record — the old one is then deactivated by
   * the usual unseen-record pass.
   *
   * Keys are prefixed so they can never collide with the numeric IDs the REST
   * API issues, which matters if the permission is granted later.
   */
  private async fetchLeaseReportPage(
    query: PropertywarePageQuery,
    correlationId: string,
  ): Promise<PropertywarePage<unknown>> {
    const offset = query.offset ?? 0;
    const limit = Math.min(query.limit ?? this.config.pageSize, this.config.pageSize);
    const { payload } = await this.request(
      new URL(this.config.leaseReportUrl!),
      correlationId,
      false,
    );
    const report = propertywareLeaseReportSchema.safeParse(payload);
    if (!report.success)
      throw new PropertywareError(
        'Propertyware returned an unexpected lease report shape.',
        'PROPERTYWARE_INVALID_LEASE_REPORT',
      );
    /**
     * Columns by label, and a loud failure when one is absent.
     *
     * These used to be fixed indices. The report was edited upstream, index 9
     * became "Balance" and index 0 became "Lease Name", and the parser went on
     * reading `$0.00` as a building id and `Abuah - Abuah` as a status. The
     * `/^active/i` test then matched 0 of 448 rows, every sync logged
     * ZERO_RECORDS_WARNING, and the lease table stayed empty — a warning that
     * reads exactly like a quiet week.
     *
     * Throwing is the fix, not a side effect. A report that cannot be read must
     * say so; returning nothing is indistinguishable from there being nothing.
     */
    const { indexes, building, missing } = leaseReportColumns(report.data.columns);
    if (missing.length)
      throw new PropertywareError(
        `The Propertyware lease report is missing ${missing.length === 1 ? 'the column' : 'the columns'} ${missing.map((label) => `"${label}"`).join(', ')}. It has: ${report.data.columns.map((column) => column.label).join(', ')}. Point PROPERTYWARE_LEASE_REPORT_URL at a report that includes ${missing.length === 1 ? 'it' : 'them'}.`,
        'PROPERTYWARE_LEASE_REPORT_MISSING_COLUMNS',
      );

    const cell = (record: Record<string, string>, field: keyof typeof indexes) =>
      (record[indexes[field]] ?? '').trim();
    const at = (record: Record<string, string>, index: string | undefined) =>
      index === undefined ? '' : (record[index] ?? '').trim();

    /**
     * The building, by id when the report gives one and by address otherwise.
     *
     * Propertyware's report builder offers no `Building Entity ID` for this
     * report, so the address is the only handle. It is resolved against the
     * building list with the same matcher the Jobber integration and the
     * tenancy sync use, so all three place one property identically.
     *
     * An address that resolves to nothing yields an empty id, and the row is
     * dropped by the filter below — the same outcome as a report row with no
     * building at all, which is what it is.
     */
    const addresses = this.buildingAddresses;

    const sourceRecords = report.data.records
      .map((record) => {
        const source = record as Record<string, string>;
        const buildingId =
          at(source, building.id) ||
          addresses?.resolve(at(source, building.address), at(source, building.postalCode)) ||
          '';
        const leaseName = cell(source, 'leaseName');
        const rawStart = cell(source, 'startDate');
        const status = cell(source, 'status');
        return {
          id: leaseReportExternalId(buildingId, leaseName, rawStart),
          buildingID: buildingId,
          leaseName,
          // Statuses read like "Active - Notice Given"; anything not starting
          // with "Active" is treated as inactive rather than guessed at.
          active: /^active/i.test(status),
          status,
          startDate: reportDate(rawStart),
          endDate: reportDate(cell(source, 'endDate')),
          noticeGivenDate: reportDate(cell(source, 'noticeGivenDate')),
          contacts: [],
        };
      })
      .filter((record) => Boolean(record.buildingID))
      .filter((record) => query.includeDeactivated === true || record.active);
    const page = sourceRecords.slice(offset, offset + limit);
    const validationErrors: NonNullable<PropertywarePage<unknown>['validationErrors']> = [];
    const records = page.flatMap((record, index) => {
      const parsed = propertywareSchemas.leases.safeParse(record);
      if (!parsed.success) {
        validationErrors.push({
          index,
          externalId: record.id || undefined,
          code: 'PROPERTYWARE_SCHEMA_ERROR',
          detail: summarizeSchemaIssues(parsed.error),
        });
        return [];
      }
      return [parsed.data];
    });
    return {
      records,
      receivedCount: page.length,
      validationErrors,
      totalCount: sourceRecords.length,
      offset,
      limit,
    };
  }

  private async fetchPortfolioReportPage(
    query: PropertywarePageQuery,
    correlationId: string,
  ): Promise<PropertywarePage<unknown>> {
    const offset = query.offset ?? 0;
    const limit = Math.min(query.limit ?? this.config.pageSize, this.config.pageSize);
    const { payload } = await this.request(
      new URL(this.config.portfolioReportUrl!),
      correlationId,
      false,
    );
    const report = propertywarePortfolioReportSchema.safeParse(payload);
    if (!report.success)
      throw new PropertywareError(
        'Propertyware returned an unexpected portfolio report shape.',
        'PROPERTYWARE_INVALID_PORTFOLIO_REPORT',
      );
    const sourceRecords = report.data.records
      .map((record) => ({
        id: record['1'].trim(),
        name: record['0'].trim(),
        active: record['4'].trim().toLowerCase() !== 'yes',
        owners: [],
      }))
      .filter((record) => query.includeDeactivated === true || record.active);
    const page = sourceRecords.slice(offset, offset + limit);
    const validationErrors: NonNullable<PropertywarePage<unknown>['validationErrors']> = [];
    const records = page.flatMap((record, index) => {
      const parsed = propertywareSchemas.portfolios.safeParse(record);
      if (!parsed.success) {
        validationErrors.push({
          index,
          externalId: record.id || undefined,
          code: 'PROPERTYWARE_SCHEMA_ERROR',
          detail: summarizeSchemaIssues(parsed.error),
        });
        return [];
      }
      return [parsed.data];
    });
    return {
      records,
      receivedCount: page.length,
      validationErrors,
      totalCount: sourceRecords.length,
      offset,
      limit,
    };
  }

  private async request(url: URL, correlationId: string, includeCredentials = true) {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      const startedAt = performance.now();
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...(includeCredentials
              ? {
                  [PROPERTYWARE_AUTH_HEADERS.clientId]: this.config.clientId ?? '',
                  [PROPERTYWARE_AUTH_HEADERS.clientSecret]: this.config.clientSecret ?? '',
                  [PROPERTYWARE_AUTH_HEADERS.organizationId]: this.config.organizationId ?? '',
                }
              : {}),
            'x-correlation-id': correlationId,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.config.maxRetries) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter)
              ? retryAfter * 1000
              : Math.min(500 * 2 ** attempt, 8000);
            this.logger.warn({
              event: 'propertyware_retry',
              correlationId,
              attempt,
              status: response.status,
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new PropertywareError(
            sanitizedProviderMessage(response.status),
            `PROPERTYWARE_HTTP_${response.status}`,
            response.status,
            retryable,
          );
        }
        this.logger.debug({
          event: 'propertyware_provider_request_completed',
          correlationId,
          attempt,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        });
        return {
          payload: (await response.json()) as unknown,
          headers: response.headers,
        };
      } catch (error) {
        if (error instanceof PropertywareError) throw error;
        const retryable = error instanceof Error && error.name === 'AbortError';
        if (attempt < this.config.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000)));
          continue;
        }
        throw new PropertywareError(
          retryable ? 'Propertyware request timed out.' : 'Propertyware network request failed.',
          retryable ? 'PROPERTYWARE_TIMEOUT' : 'PROPERTYWARE_NETWORK_ERROR',
          undefined,
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new PropertywareError(
      'Propertyware retry budget was exhausted.',
      'PROPERTYWARE_RETRIES_EXHAUSTED',
    );
  }
}
import { performance } from 'node:perf_hooks';

/**
 * Produces a compact, PII-safe reason from a Zod validation failure: field
 * paths plus type mismatches (e.g. "portfolioID: expected string, received
 * null"). It intentionally reports the shape of the problem, never the record's
 * data values.
 */
function summarizeSchemaIssues(error: { issues: readonly unknown[] }): string {
  const parts = error.issues.slice(0, 6).map((raw) => {
    const issue = raw as { path?: Array<string | number>; message?: string; errors?: unknown };
    const path = (issue.path ?? []).map(String).join('.') || '(root)';
    let message = issue.message ?? 'Invalid value';
    // Union failures nest the concrete per-branch reasons; surface the first.
    if (Array.isArray(issue.errors)) {
      const inner = (issue.errors as unknown[])
        .flat()
        .map((entry) =>
          entry && typeof entry === 'object' && 'message' in entry
            ? String((entry as { message: unknown }).message)
            : '',
        )
        .filter(Boolean);
      if (inner.length) message = inner[0]!;
    }
    return `${path}: ${message}`;
  });
  return parts.join('; ');
}
