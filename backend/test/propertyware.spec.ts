import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PropertywareClient } from '../src/integrations/propertyware/propertyware.client';
import { PropertywareError } from '../src/integrations/propertyware/propertyware.errors';
import { mockPropertywareRecords } from '../src/integrations/propertyware/propertyware.fixtures';
import {
  mapBuilding,
  mapLease,
  mapPortfolio,
  mapUnit,
  stableSourceHash,
} from '../src/integrations/propertyware/propertyware.mapper';
import { propertywarePages } from '../src/integrations/propertyware/propertyware.pagination';
import { propertywareSchemas } from '../src/integrations/propertyware/propertyware.schemas';
import type { RawPropertywareBuilding } from '../src/integrations/propertyware/propertyware.schemas';
import type {
  PropertywareConfig,
  PropertywarePageQuery,
} from '../src/integrations/propertyware/propertyware.types';
import { InMemoryPropertywareSyncStore } from '../src/workers/propertyware-sync/propertyware-sync.store';
import { PropertywareSyncWorker } from '../src/workers/propertyware-sync/propertyware-sync.worker';
import type { PropertywareEntity } from '../src/integrations/propertyware/propertyware.constants';
import type { PropertywareService } from '../src/integrations/propertyware/propertyware.service';

const organizationId = '10000000-0000-4000-8000-000000000001';
const config: PropertywareConfig = {
  provider: 'mock',
  store: 'memory',
  baseUrl: 'https://api.propertyware.com/pw/api/rest/v1',
  requestTimeoutMs: 1000,
  pageSize: 2,
  maxRetries: 1,
  syncEnabled: false,
  initialSyncLookbackDays: 30,
  cursorOverlapSeconds: 120,
  databaseConcurrency: 2,
  databaseBatchSize: 50,
};

class FixtureProvider {
  readonly queries: Array<{ entity: PropertywareEntity; query: PropertywarePageQuery }> = [];
  readonly records: Record<PropertywareEntity, unknown[]> = {
    portfolios: [...mockPropertywareRecords.portfolios],
    buildings: [...mockPropertywareRecords.buildings],
    units: [...mockPropertywareRecords.units],
    leases: [...mockPropertywareRecords.leases],
  };
  failEntity?: PropertywareEntity;
  forbiddenEntity?: PropertywareEntity;
  async fetchPage(entity: PropertywareEntity, query: PropertywarePageQuery) {
    this.queries.push({ entity, query: { ...query } });
    if (this.failEntity === entity)
      throw new PropertywareError('Temporary failure.', 'TEST_FAILURE', 500, true);
    if (this.forbiddenEntity === entity)
      throw new PropertywareError(
        'Propertyware API permission was denied.',
        'PROPERTYWARE_HTTP_403',
        403,
        false,
      );
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 2;
    const all = this.records[entity].filter(
      (item) => query.includeDeactivated || (item as { active: boolean }).active,
    );
    return { records: all.slice(offset, offset + limit), totalCount: all.length, offset, limit };
  }
}

describe('Propertyware schemas and mapping', () => {
  it('validates and maps the four documented DTOs', () => {
    const portfolio = mapPortfolio(
      propertywareSchemas.portfolios.parse(mockPropertywareRecords.portfolios[0]),
    );
    const building = mapBuilding(
      propertywareSchemas.buildings.parse(mockPropertywareRecords.buildings[0]),
    );
    const unit = mapUnit(propertywareSchemas.units.parse(mockPropertywareRecords.units[0]));
    const lease = mapLease(propertywareSchemas.leases.parse(mockPropertywareRecords.leases[0]));
    expect(portfolio.owners[0]?.displayName).toBe('Example Property Holdings');
    expect(building.portfolioExternalId).toBe('91001');
    expect(unit.buildingExternalId).toBe('93001');
    expect(lease.scheduledMoveOutDate).toBe('2026-07-31');
    expect([portfolio, building, unit, lease].every((record) => record.isActive)).toBe(true);
  });

  it('rejects a malformed provider record with no external id', () => {
    expect(() => propertywareSchemas.portfolios.parse({ name: 'Broken', active: true })).toThrow();
  });

  it('produces a stable hash independent of object key order', () => {
    const record = mapBuilding(
      propertywareSchemas.buildings.parse(mockPropertywareRecords.buildings[0]),
    );
    expect(stableSourceHash(record)).toBe(stableSourceHash({ ...record }));
  });
});

describe('Propertyware pagination and client', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PROPERTYWARE_CLIENT_ID;
    delete process.env.PROPERTYWARE_CLIENT_SECRET;
    delete process.env.PROPERTYWARE_ORGANIZATION_ID;
    delete process.env.PROPERTYWARE_PORTFOLIO_REPORT_URL;
    delete process.env.PROPERTYWARE_MAX_RETRIES;
    delete process.env.PROPERTYWARE_PROVIDER;
  });

  it('walks offset pages until X-Total-Count is exhausted', async () => {
    const fetchPage = jest.fn(async (_entity, query: PropertywarePageQuery) => ({
      records: query.offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
      totalCount: 3,
      offset: query.offset ?? 0,
      limit: 2,
    }));
    const pages = [];
    for await (const page of propertywarePages({ fetchPage }, 'portfolios', { limit: 2 }, 'run-1'))
      pages.push(page);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(pages.flatMap((page) => page.records)).toHaveLength(3);
  });

  it('uses documented auth headers, timestamp filters, and bounded 429 retry', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    process.env.PROPERTYWARE_MAX_RETRIES = '1';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockPropertywareRecords.portfolios), {
          status: 200,
          headers: { 'x-total-count': '1' },
        }),
      );
    global.fetch = fetchMock;
    await new PropertywareClient().fetchPage(
      'portfolios',
      { lastModifiedDateTimeStart: '2026-07-01T00:00:00Z', limit: 500 },
      'correlation',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.searchParams.get('lastModifiedDateTimeStart')).toBe('2026-07-01T00:00:00Z');
    expect((options.headers as Record<string, string>)['x-propertyware-system-id']).toBe('system');
  });

  it('does not retry an authentication failure', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    global.fetch = fetchMock;
    await expect(
      new PropertywareClient().fetchPage('portfolios', {}, 'correlation'),
    ).rejects.toMatchObject({ status: 401, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the validated active portfolio report when the official endpoint is forbidden', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    process.env.PROPERTYWARE_PORTFOLIO_REPORT_URL =
      'https://app.propertyware.com/pw/example/JSON?report=opaque';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            totalCount: 2,
            columns: [
              { index: '0', dataType: 'text', label: 'Portfolio Name' },
              { index: '1', dataType: 'text', label: 'Portfolio Entity ID' },
              { index: '2', dataType: 'text', label: 'Property Owners' },
              { index: '3', dataType: 'number', label: '# of Buildings' },
              { index: '4', dataType: 'text', label: 'Deactivated' },
            ],
            records: [
              { '0': 'Active Portfolio', '1': '100', '2': 'Owner', '3': '2', '4': 'No' },
              { '0': 'Old Portfolio', '1': '200', '2': 'Owner', '3': '0', '4': 'Yes' },
            ],
          }),
        ),
      );
    global.fetch = fetchMock;
    const page = await new PropertywareClient().fetchPage(
      'portfolios',
      { includeDeactivated: false, limit: 500 },
      'correlation',
    );
    expect(page.records).toHaveLength(1);
    expect(page.totalCount).toBe(1);
    const [, reportOptions] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(reportOptions.headers).not.toHaveProperty('x-propertyware-client-secret');
  });

  it('defensively excludes inactive records from active-only official API responses', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    const inactive = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/propertyware/inactive-record.json'), 'utf8'),
    );
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify([mockPropertywareRecords.buildings[0], inactive]), {
        status: 200,
        headers: { 'x-total-count': '2' },
      }),
    );
    const page = await new PropertywareClient().fetchPage(
      'buildings',
      { includeDeactivated: false, limit: 500 },
      'correlation',
    );
    expect(page.records).toHaveLength(1);
    expect((page.records[0] as { active: boolean }).active).toBe(true);
  });

  it('quarantines malformed records without breaking page offsets', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify([
            mockPropertywareRecords.buildings[0],
            { ...mockPropertywareRecords.buildings[0], id: 93002, name: '' },
          ]),
          { status: 200, headers: { 'x-total-count': '2' } },
        ),
      );
    const page = await new PropertywareClient().fetchPage(
      'buildings',
      { offset: 0, limit: 2 },
      'correlation',
    );
    expect(page.records).toHaveLength(1);
    expect(page.receivedCount).toBe(2);
    expect(page.validationErrors).toEqual([
      {
        index: 1,
        externalId: '93002',
        code: 'PROPERTYWARE_SCHEMA_ERROR',
        detail: expect.stringContaining('name'),
      },
    ]);
  });

  it('accepts a building that has no portfolio', async () => {
    // Propertyware really does return these. Rejecting them hid nineteen live
    // properties from the whole app, so a null portfolio must survive
    // validation and be persisted unassigned instead.
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify([{ ...mockPropertywareRecords.buildings[0], portfolioID: null }]),
          { status: 200, headers: { 'x-total-count': '1' } },
        ),
      );
    const page = await new PropertywareClient().fetchPage(
      'buildings',
      { offset: 0, limit: 1 },
      'correlation',
    );
    expect(page.validationErrors).toEqual([]);
    expect(page.records).toHaveLength(1);
    expect(
      mapBuilding(page.records[0] as RawPropertywareBuilding).portfolioExternalId,
    ).toBeUndefined();
  });

  it('validates a single-record building response', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(mockPropertywareRecords.buildings[0])));
    const building = await new PropertywareClient().fetchOne('buildings', '93001', 'correlation');
    expect(building.id).toBe(93001);
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [URL];
    expect(url.pathname.endsWith('/buildings/93001')).toBe(true);
  });
});

describe('Propertyware synchronization worker', () => {
  it('paginates sanitized sync errors within the requested organization and run', async () => {
    const store = new InMemoryPropertywareSyncStore();
    const run = await store.createRun(organizationId, 'initial', 'admin-user');
    await store.addError({
      runId: run.id,
      entity: 'buildings',
      externalId: 'provider-building-1',
      code: 'PROVIDER_REJECTED',
      message: 'The provider rejected the building.',
      retryable: false,
      fingerprint: 'private-payload-fingerprint',
    });

    await expect(
      store.listErrorsPage(organizationId, run.id, {
        page: 1,
        pageSize: 25,
        entityType: 'buildings',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        total: 1,
        items: [
          expect.objectContaining({
            entityType: 'buildings',
            errorCode: 'PROVIDER_REJECTED',
            sanitizedMessage: 'The provider rejected the building.',
          }),
        ],
      }),
    );
    const page = (await store.listErrorsPage(organizationId, run.id, {
      page: 1,
      pageSize: 25,
    })) as { items: Array<Record<string, unknown>> };
    expect(page.items[0]).not.toHaveProperty('externalId');
    expect(page.items[0]).not.toHaveProperty('fingerprint');
    await expect(
      store.listErrorsPage('20000000-0000-4000-8000-000000000001', run.id, {
        page: 1,
        pageSize: 25,
      }),
    ).resolves.toMatchObject({ items: [], total: 0 });
  });

  it('identifies the entity whose provider permission is missing', async () => {
    const provider = new FixtureProvider();
    provider.forbiddenEntity = 'portfolios';
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const request = {
      entities: ['portfolios', 'buildings'] as PropertywareEntity[],
      mode: 'initial' as const,
      requestedBy: 'admin',
    };
    const run = await worker.createRun(organizationId, request);
    await worker.execute(run.id, organizationId, request);
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'FAILED',
      errorSummary: expect.stringContaining('read access to portfolios'),
    });
  });

  it('is idempotent, updates modified records, and preserves active-only reads', async () => {
    const provider = new FixtureProvider();
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const initial = {
      entities: ['portfolios', 'buildings', 'units', 'leases'] as PropertywareEntity[],
      mode: 'initial' as const,
      requestedBy: 'admin',
    };
    const first = await worker.createRun(organizationId, initial);
    await worker.execute(first.id, organizationId, initial);
    expect(provider.queries.every(({ query }) => !query.lastModifiedDateTimeStart)).toBe(true);
    expect(await store.listActive('buildings', organizationId)).toHaveLength(1);
    const request = { ...initial, mode: 'incremental' as const };
    const second = await worker.createRun(organizationId, request);
    await worker.execute(second.id, organizationId, request);
    expect(((await store.getRun(second.id)) as { recordsUnchanged: number }).recordsUnchanged).toBe(
      4,
    );
    provider.records.buildings[0] = {
      ...(provider.records.buildings[0] as object),
      name: 'Updated Oak Ridge',
    };
    const third = await worker.createRun(organizationId, request);
    await worker.execute(third.id, organizationId, request);
    expect(((await store.getRun(third.id)) as { recordsUpdated: number }).recordsUpdated).toBe(1);
  });

  it('soft-deactivates only after a completed reconciliation and does not advance a failed cursor', async () => {
    const provider = new FixtureProvider();
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const initial = {
      entities: ['portfolios', 'buildings'] as PropertywareEntity[],
      mode: 'initial' as const,
      requestedBy: 'admin',
    };
    const seed = await worker.createRun(organizationId, initial);
    await worker.execute(seed.id, organizationId, initial);
    const priorCursor = await store.getCursor(organizationId, 'buildings');
    const incremental = { ...initial, mode: 'incremental' as const };
    provider.failEntity = 'buildings';
    const failed = await worker.createRun(organizationId, incremental);
    await worker.execute(failed.id, organizationId, incremental);
    expect(await store.getCursor(organizationId, 'buildings')).toEqual(priorCursor);
    expect(await store.listActive('buildings', organizationId)).toHaveLength(1);
    provider.failEntity = undefined;

    /**
     * A building that genuinely left management: the fetch still returns
     * buildings, just not this one.
     *
     * This used to set `records.buildings = []` and expect the sweep to
     * deactivate — which asserted the hazard as behaviour. An empty fetch is a
     * broken fetch, and the sweep now refuses it; see the test below. Retiring
     * a property has to be expressed as "the feed no longer lists it", because
     * that is the only form of it the sync can tell apart from a failure.
     */
    const replacement = {
      ...(mockPropertywareRecords.buildings[0] as Record<string, unknown>),
      id: '93999',
      name: '77 Replacement Way',
    };
    provider.records.buildings = [replacement];
    const reconciliation = { ...incremental, mode: 'reconciliation' as const };
    const complete = await worker.createRun(organizationId, reconciliation);
    await worker.execute(complete.id, organizationId, reconciliation);
    expect(
      provider.queries.slice(-2).every(({ query }) => query.includeDeactivated === false),
    ).toBe(true);
    // The retired one is gone and the replacement stands in its place.
    const active = (await store.listActive('buildings', organizationId)) as { name: string }[];
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe('77 Replacement Way');
    expect(
      ((await store.getRun(complete.id)) as { recordsDeactivated: number }).recordsDeactivated,
    ).toBe(1);
  });

  it('refuses to deactivate everything when the fetch comes back empty', async () => {
    /**
     * The hazard this guard exists for.
     *
     * Propertyware has returned zero records for buildings three times in this
     * account's history. All three landed on incremental runs, where the sweep
     * does not run — nothing about that was by design. On a reconciliation run
     * the same empty fetch would have deactivated every building in one pass,
     * emptying the application, and no later run would bring them back: a row
     * nobody fetches is a row nobody reactivates.
     */
    const provider = new FixtureProvider();
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const initial = {
      entities: ['portfolios', 'buildings'] as PropertywareEntity[],
      mode: 'initial' as const,
      requestedBy: 'admin',
    };
    const seed = await worker.createRun(organizationId, initial);
    await worker.execute(seed.id, organizationId, initial);
    const before = await store.listActive('buildings', organizationId);
    expect(before.length).toBeGreaterThan(0);

    provider.records.buildings = [];
    const reconciliation = { ...initial, mode: 'reconciliation' as const };
    const run = await worker.createRun(organizationId, reconciliation);
    await worker.execute(run.id, organizationId, reconciliation);

    // Nothing deactivated, and every building still standing.
    expect(
      ((await store.getRun(run.id)) as { recordsDeactivated: number }).recordsDeactivated,
    ).toBe(0);
    expect(await store.listActive('buildings', organizationId)).toHaveLength(before.length);

    // And it is not silent: a run that refuses reports zero deactivations,
    // which is exactly what a healthy run reports, so the reason has to be
    // written down somewhere a person will find it.
    const errors = await store.listErrorsPage(organizationId, run.id, { page: 1, pageSize: 50 });
    expect(
      errors.items.some((error) => error.errorCode.includes('DEACTIVATION_REFUSED')),
    ).toBe(true);
  });

  it('requires an initial sync before incremental sync and leaves the cursor unset', async () => {
    const provider = new FixtureProvider();
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const request = {
      entities: ['portfolios'] as PropertywareEntity[],
      mode: 'incremental' as const,
      requestedBy: 'admin',
    };
    const run = await worker.createRun(organizationId, request);
    await worker.execute(run.id, organizationId, request);
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'FAILED',
      errorSummary: expect.stringContaining('requires an initial sync'),
    });
    expect(await store.getCursor(organizationId, 'portfolios')).toBeUndefined();
    expect(provider.queries).toHaveLength(0);
  });

  it('dry-runs provider mapping without creating runs, records, or cursors', async () => {
    const provider = new FixtureProvider();
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const result = await worker.dryRun(['portfolios', 'buildings', 'units', 'leases']);
    expect(result.totals.recordsMapped).toBe(4);
    expect(await store.listRuns(organizationId)).toHaveLength(0);
    expect(await store.listActive('portfolios', organizationId)).toHaveLength(0);
    expect(await store.getCursor(organizationId, 'portfolios')).toBeUndefined();
  });

  it('records an explicit warning when an initial provider response is empty', async () => {
    const provider = new FixtureProvider();
    provider.records.portfolios = [];
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const request = {
      entities: ['portfolios'] as PropertywareEntity[],
      mode: 'initial' as const,
      requestedBy: 'admin',
    };
    const run = await worker.createRun(organizationId, request);
    await worker.execute(run.id, organizationId, request);
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      warnings: 1,
      recordsFetched: 0,
    });
  });

  it('verifies total and active database population counts', async () => {
    const provider = new FixtureProvider();
    const store = new InMemoryPropertywareSyncStore();
    const worker = new PropertywareSyncWorker(
      config,
      provider as unknown as PropertywareService,
      store,
    );
    const request = {
      entities: ['portfolios', 'buildings', 'units', 'leases'] as PropertywareEntity[],
      mode: 'initial' as const,
      requestedBy: 'admin',
    };
    const run = await worker.createRun(organizationId, request);
    await worker.execute(run.id, organizationId, request);
    expect(await store.verifyPopulation(organizationId)).toMatchObject({
      total: 4,
      active: 4,
      inactive: 0,
      counts: { units: { total: 1, active: 1, inactive: 0 } },
    });
  });
});
