import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RevenueDay, RevenueDayTechnician, RevenueMonthReport, SaveExcelSyncInput } from '@texasrenters/shared';

import { SaveExcelSyncDto } from '../src/admin/excel/excel-sync.controller';
import { ExcelGraphClient, encodeSharingUrl } from '../src/admin/excel/excel-graph.client';
import { ExcelSyncService } from '../src/admin/excel/excel-sync.service';
import { MicrosoftAuthService } from '../src/admin/excel/microsoft-auth.service';
import { getMicrosoftConfig, microsoftConfigured } from '../src/admin/excel/microsoft.config';
import { asText, cellText, dailyTab, monthTab, projectionTab, trackerTab, weekTab, weekTabName, type ExcelCell } from '../src/admin/excel-layout';

/** A row as Excel shows it: text, or each number in the format it was sent with. */
const shown = (row: ExcelCell[] | undefined) => (row ?? []).map(cellText);
import type { AuthenticatedUser } from '../src/common/auth';
import { sealSecret, readEnvelopeKey } from '../src/common/secret-envelope';
import { formatNumber } from '../src/admin/workbook-reader';

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
    expect(projection.rows[1]![2]).toEqual({ value: 46338, format: 'm/d/yyyy' });
    expect(shown(projection.rows[1])).toEqual(['', 'Date:', '11/12/2026']);
    expect(shown(projection.rows[2])).toEqual(['Technician', 'Drive time', 'Billable hours', 'Projected revenue', 'Remarks']);
    expect(shown(projection.rows[3])).toEqual(['Amy', '60–95 min', '5h 40m', '$505.96', '']);
    expect(shown(projection.rows.at(-1))).toEqual(['Total', '125–205 min', '11h 40m', '$1,391', '']);

    const daily = dailyTab(day('2026-11-11'));
    expect(daily.name).toBe('1111');
    expect(daily.rows[2]![4]).toBe('DIFFERENCE (ACTUAL REVENUE - PROJECTED REVENUE)');
    expect(shown(daily.rows[3])).toEqual(['AMY WILSON', '$400', '$506', '$347.98', '-$157.98', '87.00%', '8h 25m', '']);

    const tracker = trackerTab(day('2026-11-11'));
    expect(tracker.name).toBe('New 1111');
    expect(tracker.rows[1]!.at(-1)).toBe('As of 11/11/2026 for Payroll Period to Date (November 2-15)');
    expect(shown(tracker.rows[3]!.slice(0, 12))).toEqual(['Amy Wilson', '$400.00', '60–95 min', '5h 40m', '$505.96', '$347.98', '8h 25m', '0h 25m', '$23.33', '$423.33', '($75.35)', '82.20%']);
    expect(tracker.bold).toEqual([0, 1, 2, 5]);
  });

  it('name the weeks and months as the workbook does', () => {
    expect(weekTabName({ from: '2026-11-01', to: '2026-11-08' })).toBe('Nov. 2-6');
    expect(weekTabName({ from: '2026-10-01', to: '2026-10-04' })).toBe('Oct. 1-2');
    const report = month('2026-11');
    expect(weekTab(report.weeks[0]!).rows[0]).toEqual(['PERIOD COVERED: NOVEMBER 2-6, 2026']);
    expect(monthTab(report).name).toBe('Month of November');
    expect(shown(monthTab(report).rows.at(-1))).toEqual(['TOTAL', '4,000.00', '2,308.14', '(1,691.86)', '57.70%', '']);
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

/** "B4" or "A1:E6": the first cell's 0-based row and column. */
function corner(address: string) {
  const match = /^([A-Z]+)(\d+)/.exec(address)!;
  const column = [...match[1]!].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(match[2]) - 1, column };
}

/**
 * Microsoft, faked, with a workbook that keeps what is written into it: each
 * cell's value and the text Excel shows for it, and a version (cTag) that
 * moves with every change -- the console's writes and the office's edits alike.
 */
function fakeMicrosoft(options: { sheets?: string[]; status?: (call: Call) => number | undefined } = {}) {
  const calls: Call[] = [];
  const sheets = new Set(options.sheets ?? ['Amy', 'Month of October']);
  const grid = new Map<string, Map<string, { value: string | number; text: string }>>();
  let version = 1;
  const put = (sheet: string, row: number, column: number, value: string | number, format?: string) => {
    if (!grid.has(sheet)) grid.set(sheet, new Map());
    const text = typeof value === 'number' ? formatNumber(value, format ?? 'General') : value.replace(/^'/, '');
    grid.get(sheet)!.set(`${row},${column}`, { value: typeof value === 'string' ? value.replace(/^'/, '') : value, text });
  };
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
    if (call.path === '/drives/drive-1/items/item-1') return respond(200, { cTag: `"c:{item-1},${version}"` });
    if (call.path.endsWith('/createSession')) return respond(201, { id: 'session-1' });
    if (call.path.endsWith('/closeSession')) return respond(204);
    if (call.path.endsWith('/worksheets') && call.method === 'GET') return respond(200, { value: [...sheets].map((name) => ({ name })) });
    if (call.path.endsWith('/worksheets/add')) {
      sheets.add((call.body as { name: string }).name);
      version += 1;
      return respond(201, { name: (call.body as { name: string }).name });
    }
    const range = /\/worksheets\/(.+)\/range\(address='([^']+)'\)$/.exec(call.path);
    if (range) {
      const [, sheet, address] = range as unknown as [string, string, string];
      const start = corner(address);
      if (call.method === 'PATCH') {
        const body = call.body as { values: (string | number)[][]; numberFormat?: string[][] };
        body.values.forEach((row, r) => row.forEach((value, c) => put(sheet, start.row + r, start.column + c, value, body.numberFormat?.[r]?.[c])));
        version += 1;
        return respond(200, {});
      }
      if (call.method === 'GET') {
        const end = corner(address.split(':')[1] ?? address);
        const cells = grid.get(sheet) ?? new Map();
        const at = (r: number, c: number) => cells.get(`${r},${c}`);
        const rows = Array.from({ length: end.row - start.row + 1 }, (_, r) => Array.from({ length: end.column - start.column + 1 }, (_, c) => at(start.row + r, start.column + c)));
        return respond(200, { text: rows.map((row) => row.map((cell) => cell?.text ?? '')), values: rows.map((row) => row.map((cell) => cell?.value ?? '')) });
      }
    }
    if (/\/range\(address='[^']+'\)\/clear$/.test(call.path)) {
      const [, sheet, address] = /\/worksheets\/(.+)\/range\(address='([^']+)'\)\/clear$/.exec(call.path)!;
      const start = corner(address!);
      const end = corner(address!.split(':')[1] ?? address!);
      for (let r = start.row; r <= end.row; r++) for (let c = start.column; c <= end.column; c++) grid.get(sheet!)?.delete(`${r},${c}`);
      version += 1;
      return respond(200, {});
    }
    if (call.method !== 'GET') version += 1;
    return respond(200, {});
  });
  const writes = () => calls.filter((call) => call.method === 'PATCH' && call.path.includes("range(address=") && !call.path.endsWith('/format/font'));
  return {
    calls,
    writes,
    fetchSpy,
    sheets,
    /** What a cell shows in Excel. */
    shows: (sheet: string, address: string) => {
      const at = corner(address);
      return grid.get(sheet)?.get(`${at.row},${at.column}`)?.text ?? '';
    },
    /** The office types into a cell in Excel: a number shows in the format the cell already has. */
    edit: (sheet: string, address: string, value: string | number, format?: string) => {
      const at = corner(address);
      put(sheet, at.row, at.column, value, format);
      version += 1;
    },
    /** The office inserts a row above a technician's row: everything under it moves down one. */
    insertRowAbove: (sheet: string, rowNumber: number) => {
      const cells = grid.get(sheet)!;
      const moved = [...cells.entries()].map(([key, cell]) => {
        const [row, column] = key.split(',').map(Number) as [number, number];
        return [row >= rowNumber - 1 ? `${row + 1},${column}` : key, cell] as const;
      });
      grid.set(sheet, new Map(moved));
      version += 1;
    },
  };
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
  const sheets = new Map<string, { name: string; rows: unknown; bold: unknown; keys?: unknown; editable?: unknown }>();
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
      upsert: jest.fn(async ({ create }: { create: { name: string; rows: unknown; bold: unknown; keys?: unknown; editable?: unknown } }) =>
        sheets.set(create.name, JSON.parse(JSON.stringify(create))),
      ),
      deleteMany: jest.fn(async () => sheets.clear()),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: unknown }) => audits.push(data)) },
    revenueDayEntry: {
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        saved.push({ table: 'day', ...create, ...update });
        if ('dailyRemarks' in update) remarks = update.dailyRemarks as string | null;
      }),
    },
    revenueWeekEntry: { upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => saved.push({ table: 'week', ...create, ...update })) },
    revenueMonthEntry: { upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => saved.push({ table: 'month', ...create, ...update })) },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
  };
  const saved: Record<string, unknown>[] = [];
  let remarks = options.remarks ?? null;
  const revenue = {
    day: jest.fn(async (_user: unknown, date: string) => day(date, remarks)),
    month: jest.fn(async (_user: unknown, value: string) => month(value)),
  };
  const auth = new MicrosoftAuthService(db as never);
  const live = { publishChange: jest.fn() };
  const service = new ExcelSyncService(db as never, auth, revenue as never, live as never);
  return {
    service,
    db,
    sheets,
    audits,
    saved,
    live,
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
    // The workbook's version first and last: the one the console's write leaves is kept, to tell the office's edits by.
    expect(microsoft.calls[0]!.path).toBe('/drives/drive-1/items/item-1');
    expect(microsoft.calls[1]!.path).toMatch(/createSession$/);
    expect(microsoft.calls.at(-2)!.path).toMatch(/closeSession$/);
    expect(microsoft.calls.at(-1)!.path).toBe('/drives/drive-1/items/item-1');
    expect(setup.sync!.fileTag).toEqual(expect.stringContaining('item-1'));
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
    // Each figure a number in the workbook's own format, so Excel shows "$347.98" and "-$157.98" and guesses nothing; text stays text.
    expect(microsoft.writes()[0]!.body).toEqual({
      values: [['AMY WILSON', 400, 505.96, 347.98, -157.98, 0.86995, 8.4166666 / 24, 'Completed 3 visits'].map((value) => (typeof value === 'number' ? expect.closeTo(value, 6) : value))],
      numberFormat: [['@', '"$"#,##0;-"$"#,##0', '"$"#,##0;-"$"#,##0', '"$"#,##0.00;-"$"#,##0.00', '"$"#,##0.00;-"$"#,##0.00', '0.00%', '[h]"h "mm"m"', '@']],
    });
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

describe("reading the office's edits back from Excel", () => {
  const at = new Date('2026-11-17T15:00:00.000Z');
  const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);
  const timers = () => jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
  // Amy is the first technician: her rows are row 4 of the daily report and the tracker, row 3 of a week's report.
  async function written() {
    timers();
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    await setup.service.syncNow(office);
    return { microsoft, setup };
  }
  afterEach(() => jest.useRealTimers());

  it('asks only for the workbook\'s version each minute, and reads nothing while nobody has edited it', async () => {
    const { microsoft, setup } = await written();
    microsoft.calls.length = 0;
    jest.setSystemTime(later(2));
    expect(await setup.service.runIfDue(ORG)).toBeNull();
    expect(microsoft.calls.filter((call) => !call.path.includes('login'))).toEqual([expect.objectContaining({ path: '/drives/drive-1/items/item-1' })]);
    expect(setup.sync).toMatchObject({ claimedUntil: null });
  });

  it('takes a remark, a budget and work hours typed in Excel into the console, on everyone\'s page, and on the record', async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('1117', 'H4', 'Finished early, tenant away');
    // Typed into a whole-dollar cell: Excel shows "$406", the cell holds 405.5.
    microsoft.edit('1117', 'B4', 405.5, '"$"#,##0;-"$"#,##0');
    microsoft.edit('New 1117', 'G4', 0.375, '[h]"h "mm"m"');
    microsoft.edit('Nov. 16-20', 'F3', 'Short week');
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 4, putBack: 0, conflicts: 0 });
    const amy = { technicianId: 'amy' };
    expect(setup.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'day', ...amy, day: new Date('2026-11-17T00:00:00.000Z'), dailyRemarks: 'Finished early, tenant away', updatedById: null }),
        expect.objectContaining({ table: 'day', ...amy, budgetCents: 40550 }),
        expect.objectContaining({ table: 'day', ...amy, workSeconds: 9 * 3600 }),
        expect.objectContaining({ table: 'week', ...amy, weekStart: new Date('2026-11-16T00:00:00.000Z'), remarks: 'Short week' }),
      ]),
    );
    expect(setup.audits.at(-1)).toMatchObject({
      action: 'REVENUE_EXCEL_EDITS_TAKEN',
      actorUserId: null,
      metadata: { edits: expect.arrayContaining([{ tab: '1117', key: 'day|amy|2026-11-17', field: 'dailyRemarks', from: '', to: 'Finished early, tenant away' }]) },
    });
    expect(setup.live.publishChange).toHaveBeenCalledWith(ORG, expect.objectContaining({ scope: 'day', by: { userId: 'excel', name: 'Excel' } }));
    expect(setup.sync!.lastPull).toMatchObject({ taken: 4 });
    // The remark is the console's now: Excel still shows it, and the next minute finds nothing new.
    expect(microsoft.shows('1117', 'H4')).toBe('Finished early, tenant away');
    microsoft.calls.length = 0;
    jest.setSystemTime(later(3));
    expect(await setup.service.runIfDue(ORG)).toBeNull();
  });

  it('puts back a cell the console works out -- a total, the actual revenue -- as the console has it', async () => {
    const { microsoft, setup } = await written();
    const before = microsoft.shows('1117', 'D4');
    microsoft.edit('1117', 'D4', 999, '"$"#,##0.00;-"$"#,##0.00');
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 0, putBack: 1 });
    expect(setup.saved).toEqual([]);
    expect(microsoft.shows('1117', 'D4')).toBe(before);
  });

  it('keeps the console\'s value where a cell was changed in both places since the last write', async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('1117', 'H4', 'Typed in Excel');
    setup.setRemarks('Typed on the page');
    await setup.db.excelSync.update({ data: { dirtyAt: later(1) } });
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 0, conflicts: 1 });
    expect(microsoft.shows('1117', 'H4')).toBe('Typed on the page');
  });

  it('a save in the console never writes over a cell the office just typed in Excel', async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('Nov. 16-20', 'F3', 'Typed in Excel');
    // A save of something else, on the page, before the next minute's check.
    await setup.db.excelSync.update({ data: { dirtyAt: later(1) } });
    jest.setSystemTime(later(1));
    await setup.service.runIfDue(ORG);
    expect(setup.saved).toEqual([expect.objectContaining({ table: 'week', remarks: 'Typed in Excel' })]);
  });

  it('takes nothing from a tab whose rows were moved, and puts all of it back', async () => {
    const { microsoft, setup } = await written();
    microsoft.insertRowAbove('1117', 4);
    microsoft.edit('1117', 'H5', 'Typed after inserting a row');
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 0 });
    expect(run!.pulled!.putBack).toBeGreaterThan(0);
    expect(setup.saved).toEqual([]);
    expect(microsoft.shows('1117', 'A4')).toBe('AMY WILSON');
    expect(microsoft.shows('1117', 'H5')).not.toBe('Typed after inserting a row');
  });
});
