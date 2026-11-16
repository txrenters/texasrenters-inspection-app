import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RevenueDay, RevenueDayTechnician, RevenueMonthReport, SaveExcelSyncInput } from '@texasrenters/shared';

import { SaveExcelSyncDto } from '../src/admin/excel/excel-sync.controller';
import { ExcelGraphClient, encodeSharingUrl } from '../src/admin/excel/excel-graph.client';
import { ExcelSyncService } from '../src/admin/excel/excel-sync.service';
import { MicrosoftAuthService } from '../src/admin/excel/microsoft-auth.service';
import { getMicrosoftConfig, microsoftConfigured } from '../src/admin/excel/microsoft.config';
import { asText, dailyTab, monthTab, projectionTab, trackerTab, weekTab, weekTabName } from '../src/admin/excel-layout';
import type { AuthenticatedUser } from '../src/common/auth';
import { sealSecret, readEnvelopeKey } from '../src/common/secret-envelope';

/**
 * Actual vs Budget kept in step with the office's own workbook (2026-11-17;
 * the office: "everything should sync on this spreadsheet also"). Microsoft is
 * faked; the figures are the workbook's own 11/11/2026 tracker. Names invented.
 */

const ORG = '80000000-0000-4000-8000-000000000001';
const KEY_HEX = 'a'.repeat(64);
const office = {
  id: '80000000-0000-4000-8000-000000000009',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const tech = (id: string, name: string, over: Partial<RevenueDayTechnician>): RevenueDayTechnician => ({
  technician: { id, name },
  dailyBudgetCents: 61000,
  otRateCents: 8500,
  budgetCents: 61000,
  driveTime: '0–0 min',
  billableTime: '-',
  projectedCents: 0,
  actualCents: 0,
  workSeconds: null,
  typed: { budget: false, work: false },
  projectionRemarks: null,
  dailyRemarks: null,
  trackerRemarks: null,
  period: { regularSeconds: 0, overtimeSeconds: 0, budgetedCents: 0, actualCents: 0 },
  ...over,
});
const day = (date: string, remarks: string | null = null): RevenueDay => ({
  date,
  payrollPeriod: { from: '2026-11-02', to: '2026-11-15' },
  technicians: [
    tech('amy', 'Amy Wilson', {
      dailyBudgetCents: 40000, otRateCents: 5600, budgetCents: 40000, driveTime: '60–95 min', billableTime: '5h 40m',
      projectedCents: 50596, actualCents: 34798, workSeconds: 30300, dailyRemarks: remarks,
      period: { regularSeconds: 28800, overtimeSeconds: 1500, budgetedCents: 42333, actualCents: 34798 },
    }),
    tech('emanuel', 'Emanuel Hall', { driveTime: '65–110 min', billableTime: '6h 00m', projectedCents: 88500, actualCents: 89381, workSeconds: 39780 }),
  ],
});
const month = (value: string): RevenueMonthReport => ({
  month: value,
  weeks: [
    { from: '2026-11-01', to: '2026-11-08', technicians: [{ technician: { id: 'amy', name: 'Amy Wilson' }, targetCents: 200000, actualCents: 80814, daysWorked: 5, typed: { target: false, actual: false }, remarks: null }] },
    { from: '2026-11-09', to: '2026-11-15', technicians: [{ technician: { id: 'amy', name: 'Amy Wilson' }, targetCents: 200000, actualCents: 150000, daysWorked: 5, typed: { target: false, actual: false }, remarks: null }] },
    { from: '2026-11-16', to: '2026-11-22', technicians: [{ technician: { id: 'amy', name: 'Amy Wilson' }, targetCents: 200000, actualCents: 0, daysWorked: 0, typed: { target: false, actual: false }, remarks: null }] },
  ],
  technicians: [{ technician: { id: 'amy', name: 'Amy Wilson' }, targetCents: 400000, actualCents: 230814, remarks: null }],
});

describe("the workbook's tabs", () => {
  it('are named and laid out as the office named and laid out its own', () => {
    const projection = projectionTab(day('2026-11-12'));
    expect(projection.name).toBe('Projected Productivity_1112');
    expect(projection.rows[2]).toEqual(['Technician', 'Drive time', 'Billable hours', 'Projected revenue', 'Remarks']);
    expect(projection.rows[3]).toEqual(['Amy', '60–95 min', '5h 40m', '$505.96', '']);
    expect(projection.rows.at(-1)).toEqual(['Total', '125–205 min', '11h 40m', '$1,391', '']);

    const daily = dailyTab(day('2026-11-11'));
    expect(daily.name).toBe('1111');
    expect(daily.rows[2]![4]).toBe('DIFFERENCE (ACTUAL REVENUE - PROJECTED REVENUE)');
    expect(daily.rows[3]).toEqual(['AMY WILSON', '$400', '$506', '$347.98', '-$157.98', '87.00%', '8h 25m', '']);

    const tracker = trackerTab(day('2026-11-11'));
    expect(tracker.name).toBe('New 1111');
    expect(tracker.rows[1]!.at(-1)).toBe('As of 11/11/2026 for Payroll Period to Date (November 2-15)');
    expect(tracker.rows[3]!.slice(0, 12)).toEqual(['Amy Wilson', '$400.00', '60–95 min', '5h 40m', '$505.96', '$347.98', '8h 25m', '0h 25m', '$23.33', '$423.33', '($75.35)', '82.20%']);
    expect(tracker.bold).toEqual([0, 1, 2, 5]);
  });

  it('name the weeks and months as the workbook does', () => {
    expect(weekTabName({ from: '2026-11-01', to: '2026-11-08' })).toBe('Nov. 2-6');
    expect(weekTabName({ from: '2026-10-01', to: '2026-10-04' })).toBe('Oct. 1-2');
    const report = month('2026-11');
    expect(weekTab(report.weeks[0]!).rows[0]).toEqual(['PERIOD COVERED: NOVEMBER 2-6, 2026']);
    expect(monthTab(report).name).toBe('Month of November');
    expect(monthTab(report).rows.at(-1)).toEqual(['TOTAL', '4,000.00', '2,308.14', '(1,691.86)', '57.70%', '']);
  });

  it('never let a typed remark run as a formula in Excel', () => {
    expect(asText('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(asText('+1 visit')).toBe(`'+1 visit`);
    expect(asText('Completed 3 visits')).toBe('Completed 3 visits');
    expect(dailyTab(day('2026-11-11', '@SUM(A1)')).rows[3]!.at(-1)).toBe(`'@SUM(A1)`);
  });
});

// ── Microsoft, faked ────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const readBody = (body: unknown) => {
  if (!body) return undefined;
  try {
    return JSON.parse(String(body));
  } catch {
    return String(body);
  }
};

function fakeMicrosoft(options: { sheets?: string[]; status?: (call: Call) => number | undefined } = {}) {
  const calls: Call[] = [];
  const sheets = new Set(options.sheets ?? ['Amy', 'Month of October']);
  const respond = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname.replace(/^\/v1\.0/, '')), body: readBody(init?.body) };
    calls.push(call);
    const forced = options.status?.(call);
    if (forced) return respond(forced, { error: { message: 'forced' } });
    if (url.hostname === 'login.microsoftonline.com') return respond(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'Files.ReadWrite' });
    if (call.path === '/me') return respond(200, { displayName: 'App Dev', mail: 'appdev@example.com' });
    if (call.path.startsWith('/shares/')) return respond(200, { id: 'item-1', name: 'Actual Vs Budget.xlsx', webUrl: 'https://example.sharepoint.com/x', file: {}, parentReference: { driveId: 'drive-1' } });
    if (call.path.endsWith('/createSession')) return respond(201, { id: 'session-1' });
    if (call.path.endsWith('/closeSession')) return respond(204);
    if (call.path.endsWith('/worksheets') && call.method === 'GET') return respond(200, { value: [...sheets].map((name) => ({ name })) });
    if (call.path.endsWith('/worksheets/add')) {
      sheets.add((call.body as { name: string }).name);
      return respond(201, { name: (call.body as { name: string }).name });
    }
    return respond(200, {});
  });
  const writes = () => calls.filter((call) => call.method === 'PATCH' && call.path.includes("range(address=") && !call.path.endsWith('/format/font'));
  return { calls, writes, fetchSpy, sheets };
}

beforeEach(() => {
  process.env.MICROSOFT_GRAPH_TENANT_ID = 'tenant-1';
  process.env.MICROSOFT_GRAPH_CLIENT_ID = 'mailer-client';
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = 'mailer-secret';
  delete process.env.MICROSOFT_EXCEL_TENANT_ID;
  process.env.MICROSOFT_EXCEL_CLIENT_ID = 'client-1';
  process.env.MICROSOFT_EXCEL_CLIENT_SECRET = 'secret-1';
  process.env.MICROSOFT_EXCEL_REDIRECT_URI = 'https://api.example.test/api/v1/admin/actual-vs-budget/excel/callback';
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = KEY_HEX;
  delete process.env.MICROSOFT_EXCEL_CALLS_PER_RUN;
});
afterEach(() => jest.restoreAllMocks());

function connectionDb(connection: Record<string, unknown> | null) {
  let row = connection;
  return {
    microsoftConnection: {
      findUnique: jest.fn(async () => (row ? { ...row } : null)),
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        row = row ? { ...row, ...update } : { ...create };
        return row;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (row) row = { ...row, ...data };
        return { count: row ? 1 : 0 };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row!, ...data };
        return row;
      }),
    },
    get row() {
      return row;
    },
  };
}

describe('signing the Microsoft account in', () => {
  it("uses the Excel sync's own app, never the mailer's, in the mailer's company", () => {
    const config = getMicrosoftConfig();
    expect(config).toMatchObject({ tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1' });
    delete process.env.MICROSOFT_EXCEL_CLIENT_ID;
    delete process.env.MICROSOFT_EXCEL_CLIENT_SECRET;
    expect(microsoftConfigured(getMicrosoftConfig())).toBe(false);
    process.env.MICROSOFT_EXCEL_TENANT_ID = 'tenant-2';
    expect(getMicrosoftConfig().tenantId).toBe('tenant-2');
  });

  it('sends the person to Microsoft with PKCE, a sealed state and the delegated permissions', () => {
    const auth = new MicrosoftAuthService(connectionDb(null) as never);
    const url = new URL(auth.authorizationUrl({ organizationId: ORG, userId: office.id }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(auth.readState(url.searchParams.get('state')!)).toMatchObject({ organizationId: ORG, userId: office.id });
  });

  it('refuses a state it cannot open, or one too old', () => {
    const auth = new MicrosoftAuthService(connectionDb(null) as never);
    expect(() => auth.readState('forged')).toThrow(expect.objectContaining({ code: 'MICROSOFT_STATE_INVALID' }));
    const old = sealSecret(JSON.stringify({ organizationId: ORG, userId: null, codeVerifier: 'v', issuedAt: Date.now() - 11 * 60_000, nonce: 'n' }), readEnvelopeKey(KEY_HEX, 'K')!);
    expect(() => auth.readState(old)).toThrow(expect.objectContaining({ code: 'MICROSOFT_STATE_EXPIRED' }));
  });

  it('renews the key once for two callers at once, and keeps the new refresh token', async () => {
    const key = readEnvelopeKey(KEY_HEX, 'K')!;
    const db = connectionDb({ status: 'CONNECTED', accessTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenCiphertext: sealSecret('old-refresh', key) });
    const microsoft = fakeMicrosoft();
    const auth = new MicrosoftAuthService(db as never);
    const [first, second] = await Promise.all([auth.accessToken(ORG), auth.accessToken(ORG)]);
    expect([first, second]).toEqual(['new-access', 'new-access']);
    expect(microsoft.calls.filter((call) => call.path.endsWith('/token'))).toHaveLength(1);
    expect(db.row!.refreshTokenCiphertext).not.toBe(sealSecret('old-refresh', key));
  });

  it('asks for the account to be connected again when Microsoft refuses the stored sign-in', async () => {
    const key = readEnvelopeKey(KEY_HEX, 'K')!;
    const db = connectionDb({ status: 'CONNECTED', accessTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenCiphertext: sealSecret('revoked', key) });
    fakeMicrosoft({ status: (call) => (call.path.endsWith('/token') ? 400 : undefined) });
    await expect(new MicrosoftAuthService(db as never).accessToken(ORG)).rejects.toBeDefined();
    expect(db.row).toMatchObject({ status: 'REAUTHORIZATION_REQUIRED' });
  });
});

describe("the client's limits", () => {
  const auth = (callsPerRun = 80) =>
    ({
      config: () => ({ graphBaseUrl: 'https://graph.example.test', requestTimeoutMs: 5000, callsPerRun }),
      accessToken: jest.fn(async () => 'token'),
      refresh: jest.fn(async () => 'renewed'),
    }) as unknown as MicrosoftAuthService;

  it('encodes a sharing link as Microsoft says', () => {
    expect(encodeSharingUrl('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1')).toBe(
      'u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx',
    );
  });

  it('stops at the run’s budget, renews a refused key once, and stops when told to slow down', async () => {
    fakeMicrosoft({ status: (call) => (call.path.includes('slow') ? 429 : undefined) });
    const client = new ExcelGraphClient(auth(2), ORG, { driveId: 'd', itemId: 'i' });
    await client.worksheetNames();
    await client.worksheetNames();
    await expect(client.worksheetNames()).rejects.toMatchObject({ code: 'EXCEL_RUN_BUDGET_SPENT' });

    let first = true;
    jest.restoreAllMocks();
    fakeMicrosoft({ status: () => (first ? ((first = false), 401) : undefined) });
    const keys = auth();
    await new ExcelGraphClient(keys, ORG, { driveId: 'd', itemId: 'i' }).worksheetNames();
    expect(keys.refresh).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
    fakeMicrosoft({ status: () => 429 });
    await expect(new ExcelGraphClient(auth(), ORG, { driveId: 'd', itemId: 'i' }).worksheetNames()).rejects.toMatchObject({ code: 'MICROSOFT_RATE_LIMITED' });
  });
});

// ── The sync ────────────────────────────────────────────────────────────────

function syncSetup(options: { startDate?: string; remarks?: string | null } = {}) {
  const key = readEnvelopeKey(KEY_HEX, 'K')!;
  let sync: Record<string, unknown> | null = {
    organizationId: ORG,
    shareUrl: 'https://example.sharepoint.com/:x:/p/someone/abc',
    driveId: 'drive-1',
    itemId: 'item-1',
    fileName: 'Actual Vs Budget.xlsx',
    webUrl: null,
    enabled: true,
    startDate: new Date(`${options.startDate ?? '2026-11-01'}T00:00:00.000Z`),
    dirtyAt: new Date('2026-11-17T15:00:00.000Z'),
    lastPushedAt: null,
    lastError: null,
    claimedUntil: null,
  };
  const sheets = new Map<string, { name: string; rows: unknown; bold: unknown }>();
  const audits: unknown[] = [];
  const connection = connectionDb({
    status: 'CONNECTED',
    accessTokenCiphertext: sealSecret('access', key),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenCiphertext: sealSecret('refresh', key),
  });
  const db = {
    ...connection,
    excelSync: {
      findUnique: jest.fn(async () => (sync ? { ...sync } : null)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (sync = { ...sync!, ...data })),
      updateMany: jest.fn(async ({ where, data }: { where: { OR?: unknown }; data: Record<string, unknown> }) => {
        if (!sync) return { count: 0 };
        const claimedUntil = sync.claimedUntil as Date | null;
        if (where.OR && claimedUntil && claimedUntil > new Date()) return { count: 0 };
        sync = { ...sync, ...data };
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (sync = { ...data })),
    },
    excelSyncSheet: {
      findMany: jest.fn(async ({ where }: { where: { name: { in: string[] } } }) => where.name.in.filter((name) => sheets.has(name)).map((name) => sheets.get(name))),
      upsert: jest.fn(async ({ create }: { create: { name: string; rows: unknown; bold: unknown } }) => sheets.set(create.name, { ...create })),
      deleteMany: jest.fn(async () => sheets.clear()),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: unknown }) => audits.push(data)) },
  };
  let remarks = options.remarks ?? null;
  const revenue = {
    day: jest.fn(async (_user: unknown, date: string) => day(date, remarks)),
    month: jest.fn(async (_user: unknown, value: string) => month(value)),
  };
  const auth = new MicrosoftAuthService(db as never);
  const service = new ExcelSyncService(db as never, auth, revenue as never);
  return {
    service,
    db,
    sheets,
    audits,
    get sync() {
      return sync;
    },
    setRemarks: (value: string | null) => (remarks = value),
  };
}

describe('writing the workbook', () => {
  it("adds the day's tabs the workbook lacks, all of each in one write, and remembers what it wrote", async () => {
    jest.useFakeTimers({ now: new Date('2026-11-17T15:00:00.000Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    const run = await setup.service.syncNow(office);
    jest.useRealTimers();
    expect(run.tabs.map((tab) => tab.name)).toEqual([
      'Projected Productivity_1117',
      'Projected Productivity_1118',
      '1116',
      'New 1116',
      '1117',
      'New 1117',
      'Nov. 16-20',
      'Month of November',
    ]);
    expect(run.tabs.every((tab) => tab.created)).toBe(true);
    expect(microsoft.writes()).toHaveLength(8);
    expect(microsoft.writes()[0]!.path).toBe("/drives/drive-1/items/item-1/workbook/worksheets/Projected Productivity_1117/range(address='A1:E6')");
    expect(setup.sheets.size).toBe(8);
    expect(setup.sync).toMatchObject({ lastError: null, claimedUntil: null });
    expect(microsoft.calls[0]!.path).toMatch(/createSession$/);
    expect(microsoft.calls.at(-1)!.path).toMatch(/closeSession$/);
  });

  it('writes nothing when nothing changed, and only the changed row when one did', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-17T15:00:00.000Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    await setup.service.syncNow(office);
    microsoft.calls.length = 0;
    const quiet = await setup.service.syncNow(office);
    expect(microsoft.writes()).toHaveLength(0);
    expect(quiet.tabs.every((tab) => tab.rowsWritten === 0)).toBe(true);

    setup.setRemarks('Completed 3 visits');
    microsoft.calls.length = 0;
    await setup.service.syncNow(office);
    jest.useRealTimers();
    // The daily report's remark is on Amy's row: one row, on each of the two days' reports.
    expect(microsoft.writes().map((call) => call.path.replace(/.*worksheets\//, ''))).toEqual(["1116/range(address='A4:H4')", "1117/range(address='A4:H4')"]);
    expect(microsoft.writes()[0]!.body).toEqual({ values: [['AMY WILSON', '$400', '$506', '$347.98', '-$157.98', '87.00%', '8h 25m', 'Completed 3 visits']] });
  });

  it("never writes a day's tab dated before the sync's first day: those are the office's own", async () => {
    jest.useFakeTimers({ now: new Date('2026-11-17T15:00:00.000Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    fakeMicrosoft();
    const setup = syncSetup({ startDate: '2026-11-18' });
    const run = await setup.service.syncNow(office);
    jest.useRealTimers();
    expect(run.tabs.map((tab) => tab.name)).toEqual(['Projected Productivity_1118', 'Nov. 16-20', 'Month of November']);
  });

  it('runs on the schedule only when a save waits or the tabs are stale, and one server at a time', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-17T15:01:00.000Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    fakeMicrosoft();
    const setup = syncSetup();
    expect(await setup.service.runIfDue(ORG)).not.toBeNull();
    // Written, nothing new: not due.
    jest.setSystemTime(new Date('2026-11-17T15:02:00.000Z'));
    expect(await setup.service.runIfDue(ORG)).toBeNull();
    // A save: due again; but another server holds the claim.
    await setup.db.excelSync.update({ data: { dirtyAt: new Date('2026-11-17T15:02:30.000Z'), claimedUntil: new Date('2026-11-17T15:05:00.000Z') } });
    jest.setSystemTime(new Date('2026-11-17T15:03:00.000Z'));
    expect(await setup.service.runIfDue(ORG)).toBeNull();
    // Unclaimed: it runs.
    await setup.db.excelSync.update({ data: { claimedUntil: null } });
    expect(await setup.service.runIfDue(ORG)).not.toBeNull();
    // Quiet for over 15 minutes: written again, so a tab the office deleted comes back.
    jest.setSystemTime(new Date('2026-11-17T15:20:00.000Z'));
    expect(await setup.service.runIfDue(ORG)).not.toBeNull();
    jest.useRealTimers();
  });

  it('says what went wrong on the office’s row, and keeps the save waiting', async () => {
    fakeMicrosoft({ status: (call) => (call.method === 'PATCH' ? 403 : undefined) });
    const setup = syncSetup();
    await expect(setup.service.syncNow(office)).rejects.toMatchObject({ code: 'EXCEL_FORBIDDEN' });
    expect(setup.sync).toMatchObject({ lastError: expect.stringContaining('Can edit'), lastPushedAt: null, claimedUntil: null });
  });
});

describe('linking the workbook', () => {
  it('opens the link as the connected account before keeping it, from tomorrow by default', async () => {
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    await setup.db.excelSync.update({ data: { shareUrl: 'old' } });
    const view = await setup.service.save(office, { shareUrl: 'https://texasrenters-my.sharepoint.com/:x:/p/cos/IQAV' });
    expect(microsoft.calls.some((call) => call.path.startsWith('/shares/u!'))).toBe(true);
    expect(view.workbook).toMatchObject({ fileName: 'Actual Vs Budget.xlsx', shareUrl: 'https://texasrenters-my.sharepoint.com/:x:/p/cos/IQAV' });
    await expect(setup.service.save(office, { shareUrl: 'https://evil.example.com/file.xlsx' })).rejects.toMatchObject({ code: 'EXCEL_LINK_NOT_SHAREPOINT' });
  });

  it('takes every field of its request', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const every: Required<SaveExcelSyncInput> = { shareUrl: 'https://x.sharepoint.com/y', startDate: '2026-11-18', enabled: true };
    await expect(pipe.transform(every, { type: 'body', metatype: SaveExcelSyncDto })).resolves.toBeDefined();
    await expect(pipe.transform({ enabled: 'yes' }, { type: 'body', metatype: SaveExcelSyncDto })).rejects.toBeDefined();
  });
});
