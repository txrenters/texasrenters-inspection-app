import { Injectable, Logger } from '@nestjs/common';

import {
  PROPERTYWARE_AUTH_HEADERS,
  PROPERTYWARE_ENDPOINTS,
  type PropertywareEntity,
} from './propertyware.constants';
import { PropertywareError, sanitizedProviderMessage } from './propertyware.errors';
import { getPropertywareConfig } from './propertyware.config';
import { propertywarePortfolioReportSchema, propertywareSchemas } from './propertyware.schemas';
import type { PropertywarePage, PropertywarePageQuery } from './propertyware.types';

@Injectable()
export class PropertywareClient {
  private readonly logger = new Logger(PropertywareClient.name);
  private readonly config = getPropertywareConfig();

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
      if (
        entity === 'portfolios' &&
        error instanceof PropertywareError &&
        error.status === 403 &&
        this.config.portfolioReportUrl
      )
        return this.fetchPortfolioReportPage(query, correlationId);
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
        validationErrors.push({ index, externalId, code: 'PROPERTYWARE_SCHEMA_ERROR' });
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
