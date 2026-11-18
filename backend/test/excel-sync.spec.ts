import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RevenueDay, RevenueDayTechnician, RevenueLogDay, RevenueLogRow, RevenueMonthReport, SaveExcelSyncInput } from '@texasrenters/shared';
import { revenueLogTotals } from '@texasrenters/shared';

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
  // Each cell as Excel keeps it: what it holds, shows, its format -- and its formula, when it has one Excel works out.
  const grid = new Map<string, Map<string, { value: string | number; text: string; format?: string; formula?: string }>>();
  let version = 1;
  const put = (sheet: string, row: number, column: number, value: string | number, format?: string, result: string | number = 0) => {
    if (!grid.has(sheet)) grid.set(sheet, new Map());
    const cells = grid.get(sheet)!;
    const kept = format ?? cells.get(`${row},${column}`)?.format;
    // A formula typed into a Text cell stays words, as Excel keeps it; anywhere else Excel works it out (here: 0, or
    // the result the test gives).
    if (typeof value === 'string' && value.startsWith('=') && kept !== '@') {
      cells.set(`${row},${column}`, { value: result, text: String(result), format: kept, formula: value });
      return;
    }
    const text = typeof value === 'number' ? formatNumber(value, kept ?? 'General') : value.replace(/^'/, '');
    cells.set(`${row},${column}`, { value: typeof value === 'string' ? value.replace(/^'/, '') : value, text, format: kept });
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
        const body = call.body as { values?: (string | number)[][]; numberFormat?: string[][]; formulas?: string[][] };
        if (body.values) body.values.forEach((row, r) => row.forEach((value, c) => put(sheet, start.row + r, start.column + c, value, body.numberFormat?.[r]?.[c])));
        else if (body.numberFormat)
          // Only the format: what each cell holds stays as it is, as in Excel.
          body.numberFormat.forEach((row, r) =>
            row.forEach((format, c) => {
              if (!grid.has(sheet)) grid.set(sheet, new Map());
              const key = `${start.row + r},${start.column + c}`;
              const cell = grid.get(sheet)!.get(key) ?? { value: '', text: '' };
              grid.get(sheet)!.set(key, { ...cell, format });
            }),
          );
        if (body.formulas) body.formulas.forEach((row, r) => row.forEach((formula, c) => put(sheet, start.row + r, start.column + c, formula)));
        version += 1;
        return respond(200, {});
      }
      if (call.method === 'GET') {
        const end = corner(address.split(':')[1] ?? address);
        const cells = grid.get(sheet) ?? new Map();
        const at = (r: number, c: number) => cells.get(`${r},${c}`);
        const rows = Array.from({ length: end.row - start.row + 1 }, (_, r) => Array.from({ length: end.column - start.column + 1 }, (_, c) => at(start.row + r, start.column + c)));
        return respond(200, {
          text: rows.map((row) => row.map((cell) => cell?.text ?? '')),
          values: rows.map((row) => row.map((cell) => cell?.value ?? '')),
          formulas: rows.map((row) => row.map((cell) => cell?.formula ?? cell?.value ?? '')),
          numberFormat: rows.map((row) => row.map((cell) => cell?.format ?? 'General')),
        });
      }
    }
    const used = /\/worksheets\/(.+)\/usedRange\(valuesOnly=true\)$/.exec(call.path);
    if (used) {
      // Values only, as Excel counts them: a formula showing nothing ("") is not a value.
      const rows = [...(grid.get(used[1]!)?.entries() ?? [])].filter(([, cell]) => cell.value !== '').map(([key]) => Number(key.split(',')[0]));
      return respond(200, { address: rows.length ? `${used[1]}!A1:S${Math.max(...rows) + 1}` : `${used[1]}!A1` });
    }
    if (/\/format\/fill(\/clear)?$/.test(call.path)) return respond(200, {});
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
    /** A cell as Excel keeps it: its formula, and its format. */
    cell: (sheet: string, address: string) => {
      const at = corner(address);
      return grid.get(sheet)?.get(`${at.row},${at.column}`);
    },
    /** The office types into a cell in Excel: a number shows in the format the cell already has; a formula shows `result`. */
    edit: (sheet: string, address: string, value: string | number, format?: string, result?: string | number) => {
      const at = corner(address);
      put(sheet, at.row, at.column, value, format, result);
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

const NAMES: Record<string, string> = { amy: 'Amy Wilson', kevin: 'Kevin Granados', moses: 'Moses Rodriguez', thomas: 'Thomas Allen' };

function syncSetup(
  options: {
    startDate?: string;
    remarks?: string | null;
    logs?: Record<string, RevenueLogDay[]>;
    /** For a log tab taken over: the console's visits and log entries the import finds. */
    visits?: Record<string, unknown>[];
    entries?: Record<string, unknown>[];
  } = {},
) {
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
  const sheets = new Map<
    string,
    {
      name: string;
      organizationId?: string;
      rows: unknown;
      bold: unknown;
      keys?: unknown;
      editable?: unknown;
      origin?: number | null;
      adoptedFrom?: Date | null;
      formulaCells?: unknown;
      formatsCheckedAt?: Date | string | null;
      updatedAt?: Date;
    }
  >();
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
      findMany: jest.fn(async ({ where }: { where: { name?: { in: string[] } } }) =>
        (where.name ? where.name.in.filter((name) => sheets.has(name)) : [...sheets.keys()]).map((name) => ({ ...sheets.get(name)! })),
      ),
      upsert: jest.fn(async ({ create, update }: { create: { name: string } & Record<string, unknown>; update: Record<string, unknown> }) => {
        const kept = sheets.get(create.name);
        const row = kept ? { ...kept, ...update } : { ...create };
        // As the database keeps them: JSON as JSON, a day as a day -- and when the row was last written.
        sheets.set(create.name, { ...JSON.parse(JSON.stringify(row)), adoptedFrom: (row as { adoptedFrom?: Date }).adoptedFrom ?? null, updatedAt: new Date() });
        return sheets.get(create.name);
      }),
      update: jest.fn(async ({ where, data }: { where: { organizationId_name: { name: string } }; data: Record<string, unknown> }) => {
        const name = where.organizationId_name.name;
        sheets.set(name, { ...sheets.get(name)!, ...JSON.parse(JSON.stringify(data)) });
        return sheets.get(name);
      }),
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
    revenueLogEntry: {
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => saved.push({ table: 'log', ...create, ...update })),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => saved.push({ table: 'log', ...where, ...data })),
      findMany: jest.fn(async () => (options.entries ?? []).map((entry) => ({ ...entry }))),
      createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const row of data) saved.push({ table: 'log', created: true, ...row });
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => saved.push({ table: 'log', updated: where.id, ...data })),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    inspection: { findMany: jest.fn(async () => options.visits ?? []) },
    revenueTechnicianSetting: { findMany: jest.fn(async () => []) },
    revenueMonthEntry: { upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => saved.push({ table: 'month', ...create, ...update })) },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
  };
  const saved: Record<string, unknown>[] = [];
  let remarks = options.remarks ?? null;
  const logs = options.logs ?? {};
  const revenue = {
    day: jest.fn(async (_user: unknown, date: string) => day(date, remarks)),
    month: jest.fn(async (_user: unknown, value: string) => month(value)),
    technicians: jest.fn(async () => ({ technicians: Object.keys(logs).map((id) => ({ id, name: NAMES[id] ?? 'Kevin Granados' })) })),
    log: jest.fn(async (_user: unknown, query: { technicianId: string; from: string; to: string }) => ({
      technician: { id: query.technicianId, name: 'x' },
      from: query.from,
      to: query.to,
      days: (logs[query.technicianId] ?? []).filter((logDay) => logDay.date >= query.from && logDay.date <= query.to),
    })),
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
    logs,
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
    // The session opens at the first write, just before it -- not before the reads.
    const opened = microsoft.calls.findIndex((call) => call.path.endsWith('/createSession'));
    expect(microsoft.calls.findIndex((call) => call.method !== 'GET')).toBe(opened);
    expect(microsoft.calls[opened + 1]!.method).not.toBe('GET');
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
    // The daily report's remark is on Amy's row: that one cell, on each of the two days' reports -- nothing else in the row.
    expect(microsoft.writes().map((call) => call.path.replace(/.*worksheets\//, ''))).toEqual(["1116/range(address='H4:H4')", "1117/range(address='H4:H4')"]);
    // Each figure a number in the workbook's own format, so Excel shows "$347.98" and "-$157.98" and guesses nothing; text stays text.
    expect(microsoft.writes()[0]!.body).toEqual({ values: [['Completed 3 visits']], numberFormat: [['General']] });
    // The figures stay numbers in the workbook's own formats, as the whole row was first written.
    expect(microsoft.shows('1116', 'D4')).toBe('$347.98');
    expect(microsoft.shows('1116', 'E4')).toBe('-$157.98');
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

  it('says what went wrong on the office’s row, keeps the save waiting, and does not try again for a while', async () => {
    fakeMicrosoft({ status: (call) => (call.method === 'PATCH' ? 403 : undefined) });
    const setup = syncSetup();
    await expect(setup.service.syncNow(office)).rejects.toMatchObject({ code: 'EXCEL_FORBIDDEN' });
    expect(setup.sync).toMatchObject({ lastError: expect.stringContaining('Can edit'), lastPushedAt: null });
    // Not again at once (2026-11-18): a failure that repeats would be another call on the workbook every minute.
    expect((setup.sync!.claimedUntil as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
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

  it("leaves a cell the console works out -- a total, the actual revenue -- as the office changed it, and never writes over it (2026-11-18: the spreadsheet is the source of truth)", async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('1117', 'D4', 999, '"$"#,##0.00;-"$"#,##0.00');
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 0, putBack: 0, kept: 1 });
    expect(setup.saved).toEqual([]);
    expect(microsoft.shows('1117', 'D4')).toBe('$999.00');
    // Later the console's own figure there changes: the office's stands.
    (setup.sheets.get('1117')!.rows as unknown[][])[3]![3] = { value: 1, format: '"$"#,##0.00;-"$"#,##0.00' };
    await setup.db.excelSync.update({ data: { dirtyAt: later(3) } });
    microsoft.calls.length = 0;
    jest.setSystemTime(later(4));
    await setup.service.runIfDue(ORG);
    expect(microsoft.writes().some((call) => call.path.includes("1117/range(address='D4"))).toBe(false);
    expect(microsoft.shows('1117', 'D4')).toBe('$999.00');
  });

  it('never writes over the office\'s typing: a cell changed in both places since the last write takes Excel\'s value', async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('1117', 'H4', 'Typed in Excel');
    setup.setRemarks('Typed on the page');
    await setup.db.excelSync.update({ data: { dirtyAt: later(1) } });
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 1, conflicts: 1 });
    expect(setup.saved).toEqual([expect.objectContaining({ table: 'day', dailyRemarks: 'Typed in Excel' })]);
    expect(microsoft.shows('1117', 'H4')).toBe('Typed in Excel');
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

  it("takes nothing from a tab whose rows were moved, and leaves it to the office: the console writes it no more", async () => {
    const { microsoft, setup } = await written();
    microsoft.insertRowAbove('1117', 4);
    microsoft.edit('1117', 'H5', 'Typed after inserting a row');
    microsoft.calls.length = 0;
    jest.setSystemTime(later(2));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 0, putBack: 0 });
    expect(run!.pulled!.kept).toBeGreaterThan(0);
    expect(setup.saved).toEqual([]);
    expect(microsoft.writes().some((call) => call.path.includes('/1117/'))).toBe(false);
    expect(microsoft.shows('1117', 'A4')).toBe('');
    expect(microsoft.shows('1117', 'A5')).toBe('AMY WILSON');
    expect(microsoft.shows('1117', 'H5')).toBe('Typed after inserting a row');
  });

  it("never writes a tab of the console's name that the office made itself", async () => {
    timers();
    const microsoft = fakeMicrosoft({ sheets: ['Amy', 'Month of October', 'Projected Productivity_1118'] });
    microsoft.edit('Projected Productivity_1118', 'B4', '=Amy!E405');
    const setup = syncSetup();
    await setup.service.syncNow(office);
    expect(microsoft.writes().some((call) => call.path.includes('/Projected Productivity_1118/'))).toBe(false);
    expect(microsoft.cell('Projected Productivity_1118', 'B4')).toMatchObject({ formula: '=Amy!E405' });
    expect(setup.sheets.has('Projected Productivity_1118')).toBe(false);
  });
});

describe("each technician's own log tab", () => {
  const at = new Date('2026-11-18T15:00:00.000Z');
  const timers = () => jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
  afterEach(() => jest.useRealTimers());

  const row = (date: string, over: Partial<RevenueLogRow>): RevenueLogRow => ({
    key: over.inspectionId ?? over.entryId ?? date,
    inspectionId: null,
    entryId: null,
    date,
    address: null, workOrder: null, jobNumber: null, driveTime: null, timeBudgeted: null, estimatedBudgetCents: null,
    arrival: null, leaving: null, workComplete: null, rescheduleRequired: null, rescheduleOn: null,
    laborCents: null, serviceCallFeeCents: null, materialsCents: null, invoiceNumber: null, postedInPw: null, notes: null,
    actualSeconds: null,
    filled: {},
    corrected: [],
    ...over,
  });
  const logDay = (date: string, rows: RevenueLogRow[]): RevenueLogDay => ({ date, rows, totals: revenueLogTotals(rows) });
  const amyLog = () => [
    logDay('2026-11-18', [
      row('2026-11-18', { inspectionId: 'visit-1', address: '1 Example Way - Zone 2 - Move in inspection', jobNumber: '20373', driveTime: '10–15 min', arrival: '08:44', leaving: '10:15', actualSeconds: 5460, workComplete: true, laborCents: 21000, postedInPw: '2026-11-18' }),
      row('2026-11-18', { entryId: 'entry-1', address: '2 Sample Ct - office row', estimatedBudgetCents: 7899 }),
    ]),
    logDay('2026-11-19', [row('2026-11-19', { inspectionId: 'visit-2', address: '3 Later Ln', jobNumber: '20400' })]),
  ];
  // The office's own rows on Amy's tab: its headings and months of visits, down to row 10.
  async function written(logs = { amy: amyLog() }) {
    timers();
    const microsoft = fakeMicrosoft({ sheets: ['Amy', 'Month of October'] });
    microsoft.edit('Amy', 'A1', 'Date');
    microsoft.edit('Amy', 'B10', '99 Office Rd - the office’s last row');
    const setup = syncSetup({ startDate: '2026-11-18', logs });
    const run = await setup.service.syncNow(office);
    return { microsoft, setup, run };
  }

  it("goes under the office's rows, one row down, in the log's 19 columns -- the Total rows are the office's", async () => {
    const { microsoft, setup, run } = await written();
    expect(run.tabs.find((tab) => tab.name === 'Amy')).toEqual({ name: 'Amy', created: false, rowsWritten: 3 });
    expect(microsoft.writes().find((call) => call.path.includes('/Amy/'))!.path).toContain("range(address='A12:S14')");
    expect(microsoft.shows('Amy', 'B10')).toBe('99 Office Rd - the office’s last row');
    const shown = (address: string) => microsoft.shows('Amy', address);
    expect(['A12', 'B12', 'D12', 'E12', 'H12', 'I12', 'J12', 'K12', 'N12', 'R12'].map(shown)).toEqual([
      '11/18/2026', '1 Example Way - Zone 2 - Move in inspection', '20373', '10–15 min', '8:44 AM', '10:15 AM', '1h 31m', 'Yes', '210.00', '11/18/2026',
    ]);
    expect(['A13', 'B13', 'G13', 'A14', 'B14'].map(shown)).toEqual(['11/18/2026', '2 Sample Ct - office row', '78.99', '11/19/2026', '3 Later Ln']);
    // No Total row, bold or fill: only the office knows where its totals sit. Nothing is added, and the office's column widths stay.
    expect(microsoft.calls.some((call) => call.path.includes('/Amy/') && /format\/(fill|font)/.test(call.path))).toBe(false);
    expect(microsoft.calls.some((call) => call.path.includes('/Amy/') && call.path.endsWith('autofitColumns'))).toBe(false);
    expect(microsoft.calls.some((call) => call.path.endsWith('/worksheets/add') && (call.body as { name: string }).name === 'Amy')).toBe(false);
    expect(setup.sheets.get('Amy')).toMatchObject({ origin: 11 });
  });

  it('a Job# changed on the page is in Excel at the next write: that row, where it is', async () => {
    const { microsoft, setup } = await written();
    setup.logs.amy![0]!.rows[0]!.jobNumber = '20374';
    await setup.db.excelSync.update({ data: { dirtyAt: new Date(at.getTime() + 60_000) } });
    microsoft.calls.length = 0;
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    await setup.service.runIfDue(ORG);
    // That one cell: the rest of the row is left as it is in Excel.
    expect(microsoft.writes().filter((call) => call.path.includes('/Amy/')).map((call) => call.path.replace(/.*address='([^']+)'.*/, '$1'))).toEqual(['D12:D12']);
    expect(microsoft.shows('Amy', 'D12')).toBe('20374');
  });

  it("takes a log cell typed in Excel -- on a visit's row and on the office's own row -- into the console", async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('Amy', 'C12', '37826');
    microsoft.edit('Amy', 'S13', 'Gate code changed');
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 2, putBack: 0 });
    expect(setup.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'log', inspectionId: 'visit-1', technicianId: 'amy', day: new Date('2026-11-18T00:00:00.000Z'), workOrder: '37826', updatedById: null }),
        expect.objectContaining({ table: 'log', id: 'entry-1', organizationId: ORG, notes: 'Gate code changed' }),
      ]),
    );
    expect(setup.live.publishChange).toHaveBeenCalledWith(ORG, expect.objectContaining({ scope: 'log', cells: expect.arrayContaining(['log:visit-1:workOrder']) }));
  });

  it("is only for a technician whose own tab is in the workbook, and only from the sync's first day", async () => {
    const { run, setup } = await written({ amy: amyLog(), kevin: amyLog() } as never);
    expect(run.tabs.map((tab) => tab.name)).toContain('Amy');
    expect(run.tabs.map((tab) => tab.name)).not.toContain('Kevin');
    expect(setup.sheets.get('Amy')!.rows).toHaveLength(3);
  });

  // ── Rows found by what they are (2026-11-18: the office adds and moves rows in its tabs) ──
  const runAgain = async (setup: ReturnType<typeof syncSetup>, minutes: number, save = false) => {
    if (save) await setup.db.excelSync.update({ data: { dirtyAt: new Date(at.getTime() + (minutes - 1) * 60_000) } });
    jest.setSystemTime(new Date(at.getTime() + minutes * 60_000));
    return setup.service.runIfDue(ORG);
  };
  const addresses = (microsoft: ReturnType<typeof fakeMicrosoft>) => microsoft.writes().filter((call) => call.path.includes('/Amy/')).map((call) => call.path.replace(/.*address='([^']+)'.*/, '$1'));

  it('finds a row the office moved down by inserting rows above it: a change on the page goes into that row, and a cell typed there comes in', async () => {
    const { microsoft, setup } = await written();
    // The office inserts a row above the visit's and types a Total in it, and a work order on the visit's row, now 13.
    microsoft.insertRowAbove('Amy', 12);
    microsoft.edit('Amy', 'A12', 'Total');
    microsoft.edit('Amy', 'C13', '37826');
    setup.logs.amy![0]!.rows[0]!.jobNumber = '20374';
    microsoft.calls.length = 0;
    const run = await runAgain(setup, 2, true);
    expect(run!.pulled).toMatchObject({ taken: 1, conflicts: 0 });
    expect(setup.saved).toEqual([expect.objectContaining({ table: 'log', inspectionId: 'visit-1', workOrder: '37826' })]);
    // Only the Job# cell of the visit's row, where the row is now; the office's Total and its typing stand.
    expect(addresses(microsoft)).toEqual(['D13:D13']);
    expect(['A12', 'C13', 'D13'].map((address) => microsoft.shows('Amy', address))).toEqual(['Total', '37826', '20374']);
  });

  it("brings a row the office added into the console, once -- and never brings in a second row for a visit already on the tab", async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('Amy', 'A15', 46344, 'm/d/yyyy');
    microsoft.edit('Amy', 'B15', '7 New Rd - Zone 4');
    microsoft.edit('Amy', 'G15', 45, '#,##0.00;-#,##0.00;"-"');
    microsoft.edit('Amy', 'A16', 46344, 'm/d/yyyy');
    microsoft.edit('Amy', 'B16', 'a second row for job 20373');
    microsoft.edit('Amy', 'D16', '20373');
    const run = await runAgain(setup, 2);
    expect(run!.pulled).toMatchObject({ taken: 1 });
    const created = setup.saved.filter((saved) => saved.created);
    expect(created).toEqual([
      expect.objectContaining({ technicianId: 'amy', day: new Date('2026-11-18T00:00:00.000Z'), address: '7 New Rd - Zone 4', estimatedBudgetCents: 4500, jobNumber: null }),
    ]);
    expect(setup.audits.at(-1)).toMatchObject({ action: 'REVENUE_EXCEL_ROWS_ADDED', metadata: { rows: [{ tab: 'Amy', date: '2026-11-18', address: '7 New Rd - Zone 4' }] } });
    // The console has it now, as the office's own row: found where it is, never written again at the foot.
    setup.logs.amy![0]!.rows.push(row('2026-11-18', { entryId: 'entry-new', address: '7 New Rd - Zone 4', estimatedBudgetCents: 4500 }));
    microsoft.calls.length = 0;
    const next = await runAgain(setup, 4, true);
    expect(next!.pulled?.taken ?? 0).toBe(0);
    expect(setup.saved.filter((saved) => saved.created)).toHaveLength(1);
    expect(addresses(microsoft)).toEqual([]);
  });

  it('leaves a row the office deleted deleted, and a new console row goes in at the foot, under the office\'s rows', async () => {
    const { microsoft, setup } = await written();
    // The office deletes the 11/19 row and types a row of its own under the console's.
    microsoft.edit('Amy', 'A14', '');
    microsoft.edit('Amy', 'B14', '');
    microsoft.edit('Amy', 'D14', '');
    microsoft.edit('Amy', 'A15', 'Total');
    setup.logs.amy![1]!.rows.push(row('2026-11-19', { inspectionId: 'visit-3', address: '4 Next St', jobNumber: '20401' }));
    microsoft.calls.length = 0;
    await runAgain(setup, 2, true);
    expect(addresses(microsoft)).toEqual(['A16:S16']);
    expect(['B14', 'A15', 'B16', 'D16'].map((address) => microsoft.shows('Amy', address))).toEqual(['', 'Total', '4 Next St', '20401']);
  });

  it("an office cell that differs from the console's on a row both changed: Excel's stands; a cell the office emptied stays empty, both sides", async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('Amy', 'S13', 'Typed in Excel');
    microsoft.edit('Amy', 'E12', '');
    setup.logs.amy![0]!.rows[1]!.notes = 'Typed on the page';
    const run = await runAgain(setup, 2, true);
    expect(run!.pulled).toMatchObject({ taken: 1, conflicts: 1 });
    expect(setup.saved).toEqual([expect.objectContaining({ table: 'log', id: 'entry-1', notes: 'Typed in Excel' })]);
    expect(microsoft.shows('Amy', 'S13')).toBe('Typed in Excel');
    // The drive time emptied in Excel: nothing taken, nothing written back -- this run or the next.
    setup.logs.amy![0]!.rows[1]!.notes = 'Typed in Excel';
    await runAgain(setup, 4, true);
    expect(microsoft.shows('Amy', 'E12')).toBe('');
    expect(setup.saved.some((saved) => 'driveTime' in saved)).toBe(false);
  });

  it("never writes over the office's formula in a log row -- its Actual Time works itself out from the times the console writes", async () => {
    const { microsoft, setup } = await written();
    microsoft.edit('Amy', 'J12', '=MOD(I12-H12,1)');
    await runAgain(setup, 2);
    // The leaving time changes on the page: the console writes it, and leaves the office's Actual Time to work itself out.
    Object.assign(setup.logs.amy![0]!.rows[0]!, { leaving: '10:45', actualSeconds: 7260 });
    microsoft.calls.length = 0;
    await runAgain(setup, 4, true);
    expect(addresses(microsoft)).toEqual(['I12:I12']);
    expect(microsoft.cell('Amy', 'J12')).toMatchObject({ formula: '=MOD(I12-H12,1)' });
  });

  it("never empties a row holding the office's formula, and never writes over a formula under the tab's last row (2026-11-18: \"all the formulas from the spreadsheet should not be removed\")", async () => {
    const { microsoft, setup } = await written();
    // The office's Actual Time formula in the 11/19 row, showing what the console wrote there; and formulas dragged
    // down two rows under the tab's last, showing nothing.
    microsoft.edit('Amy', 'J14', '=MOD(I14-H14,1)', undefined, '');
    microsoft.edit('Amy', 'J15', '=MOD(I15-H15,1)', undefined, '');
    microsoft.edit('Amy', 'J16', '=MOD(I16-H16,1)', undefined, '');
    // The 11/19 visit moves to 11/18 on the page.
    const visit = setup.logs.amy![1]!.rows.pop()!;
    setup.logs.amy![0]!.rows.push({ ...visit, date: '2026-11-18' });
    microsoft.calls.length = 0;
    await runAgain(setup, 2, true);
    expect(microsoft.calls.some((call) => call.path.endsWith('/clear'))).toBe(false);
    expect(microsoft.cell('Amy', 'J14')).toMatchObject({ formula: '=MOD(I14-H14,1)' });
    // The visit on its new day goes in under the formulas, not over them.
    expect(['J15', 'J16'].map((address) => microsoft.cell('Amy', address)?.formula)).toEqual(['=MOD(I15-H15,1)', '=MOD(I16-H16,1)']);
    expect(microsoft.shows('Amy', 'B17')).toBe('3 Later Ln');
  });

  it('empties the row of a visit moved to another day, when the office never typed in it, and writes the visit on its new day', async () => {
    const { microsoft, setup } = await written();
    const visit = setup.logs.amy![1]!.rows.pop()!;
    setup.logs.amy![0]!.rows.push({ ...visit, date: '2026-11-18' });
    microsoft.calls.length = 0;
    await runAgain(setup, 2, true);
    expect(microsoft.calls.some((call) => call.path.endsWith("/Amy/range(address='A14:S14')/clear"))).toBe(true);
    expect(['A15', 'B15'].map((address) => microsoft.shows('Amy', address))).toEqual(['11/18/2026', '3 Later Ln']);
    // Nothing of it brought back in as the office's own row.
    expect(setup.saved.filter((saved) => saved.created)).toEqual([]);
  });
});

describe("a technician's log tab, taken over from the sync's first day", () => {
  const at = new Date('2026-11-18T15:00:00.000Z');
  afterEach(() => jest.useRealTimers());
  const row = (date: string, over: Partial<RevenueLogRow>): RevenueLogRow => ({
    key: over.inspectionId ?? over.entryId ?? date,
    inspectionId: null,
    entryId: null,
    date,
    address: null, workOrder: null, jobNumber: null, driveTime: null, timeBudgeted: null, estimatedBudgetCents: null,
    arrival: null, leaving: null, workComplete: null, rescheduleRequired: null, rescheduleOn: null,
    laborCents: null, serviceCallFeeCents: null, materialsCents: null, invoiceNumber: null, postedInPw: null, notes: null,
    actualSeconds: null,
    filled: {},
    corrected: [],
    ...over,
  });
  const logDay = (date: string, rows: RevenueLogRow[]): RevenueLogDay => ({ date, rows, totals: revenueLogTotals(rows) });
  // On the page: Moses's visit on 11/17, its Job# typed over as 20374.
  const mosesLog = () => [
    logDay('2026-11-17', [row('2026-11-17', { inspectionId: 'visit-17518', address: '17518 Autumn Hills Dr - 17518 Autumn Hills Dr - Zone 2', jobNumber: '20374' })]),
  ];
  // Moses's tab as the office keeps it: a day before the first day, then its own rows of 11/17 and 11/18, and the
  // block the console wrote under them before this.
  function officeTab(microsoft: ReturnType<typeof fakeMicrosoft>) {
    microsoft.edit('Moses', 'B2', 'Address');
    // Excel's day numbers: 46342 is 11/16/2026, 46343 is 11/17, 46344 is 11/18.
    microsoft.edit('Moses', 'A3', 46342, 'm/d/yyyy');
    microsoft.edit('Moses', 'B3', '5 Before Rd - Zone 1');
    microsoft.edit('Moses', 'A4', 'Total');
    microsoft.edit('Moses', 'A6', 46343, 'm/d/yyyy');
    microsoft.edit('Moses', 'B6', '17518 Autumn Hills Dr - Zone 2 - Q4 2026 Tenant Benefit Package');
    microsoft.edit('Moses', 'D6', '20373');
    microsoft.edit('Moses', 'E6', '10–15 min');
    microsoft.edit('Moses', 'A7', 46344, 'm/d/yyyy');
    microsoft.edit('Moses', 'B7', '9 Unplanned St - Zone 3');
    microsoft.edit('Moses', 'A8', 'Total');
  }

  async function takenOver(options: { startDate?: string } = {}) {
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft({ sheets: ['Moses', 'Month of October'] });
    officeTab(microsoft);
    const setup = syncSetup({
      startDate: options.startDate ?? '2026-11-17',
      logs: { moses: mosesLog() },
      visits: [{ id: 'visit-17518', scheduledAt: new Date('2026-11-17T00:00:00.000Z'), jobberJobNumber: '20373', assignments: [{ technicianId: 'moses' }] }],
      entries: [{ id: 'entry-17518', organizationId: ORG, technicianId: 'moses', inspectionId: 'visit-17518', day: new Date('2026-11-17T00:00:00.000Z'), jobNumber: '20374', importedFields: null }],
    });
    const run = await setup.service.syncNow(office);
    return { microsoft, setup, run };
  }

  it("leaves every cell of the tab as it is (2026-11-18: the spreadsheet is the source of truth): the office's row for the visit, found by its street, comes into the console, and its own rows come in too", async () => {
    const { microsoft, setup } = await takenOver();
    // The office's 11/17 row is the visit, found by its street though its Job# differs from the console's: what the
    // office typed in it comes into the console -- its Job# 20373 too.
    expect(setup.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'log', inspectionId: 'visit-17518', jobNumber: '20373' }),
        expect.objectContaining({ table: 'log', inspectionId: 'visit-17518', driveTime: '10–15 min' }),
        expect.objectContaining({ table: 'log', inspectionId: 'visit-17518', address: '17518 Autumn Hills Dr - Zone 2 - Q4 2026 Tenant Benefit Package' }),
      ]),
    );
    // The office's row with no visit is the office's own row in the console now.
    expect(setup.saved.filter((saved) => saved.created).map((saved) => saved.address)).toEqual(['9 Unplanned St - Zone 3']);
    expect(setup.audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'REVENUE_EXCEL_LOG_TAKEN_OVER', actorUserId: null })]));
    // Nothing cleared, nothing written over: the tab is as the office left it.
    expect(microsoft.calls.some((call) => call.path.includes('/Moses/') && call.path.endsWith('/clear'))).toBe(false);
    expect(microsoft.writes().some((call) => call.path.includes('/Moses/'))).toBe(false);
    expect(['B3', 'B6', 'D6', 'E6', 'A8', 'B7'].map((address) => microsoft.shows('Moses', address))).toEqual([
      '5 Before Rd - Zone 1',
      '17518 Autumn Hills Dr - Zone 2 - Q4 2026 Tenant Benefit Package',
      '20373',
      '10–15 min',
      'Total',
      '9 Unplanned St - Zone 3',
    ]);
    expect(setup.sheets.get('Moses')).toMatchObject({ origin: 5, adoptedFrom: new Date('2026-11-17T00:00:00.000Z') });
  });

  it('is taken over once: the next write rewrites only what changed, from where it began', async () => {
    const { microsoft, setup } = await takenOver();
    // The console holds what the office typed now.
    Object.assign(setup.logs.moses![0]!.rows[0]!, { jobNumber: '20373', driveTime: '10–15 min', address: '17518 Autumn Hills Dr - Zone 2 - Q4 2026 Tenant Benefit Package' });
    microsoft.calls.length = 0;
    await setup.db.excelSync.update({ data: { dirtyAt: new Date(at.getTime() + 60_000) } });
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    await setup.service.runIfDue(ORG);
    expect(microsoft.calls.some((call) => call.path.includes('/Moses/') && /usedRange|clear$/.test(call.path))).toBe(false);
    expect(setup.audits.filter((audit) => (audit as { action: string }).action === 'REVENUE_EXCEL_LOG_TAKEN_OVER')).toHaveLength(1);
  });

  it('is taken over once: a first day moved later or earlier never clears its rows again', async () => {
    const { microsoft, setup } = await takenOver();
    // The console holds what the office typed now.
    Object.assign(setup.logs.moses![0]!.rows[0]!, { jobNumber: '20373', driveTime: '10–15 min', address: '17518 Autumn Hills Dr - Zone 2 - Q4 2026 Tenant Benefit Package' });
    await setup.db.excelSync.update({ data: { startDate: new Date('2026-11-18T00:00:00.000Z'), dirtyAt: new Date(at.getTime() + 60_000) } });
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    await setup.service.runIfDue(ORG);
    expect(microsoft.shows('Moses', 'D6')).toBe('20373');
    expect(setup.audits.filter((audit) => (audit as { action: string }).action === 'REVENUE_EXCEL_LOG_TAKEN_OVER')).toHaveLength(1);

    await setup.db.excelSync.update({ data: { startDate: new Date('2026-11-16T00:00:00.000Z'), dirtyAt: new Date(at.getTime() + 180_000) } });
    microsoft.calls.length = 0;
    jest.setSystemTime(new Date(at.getTime() + 240_000));
    await setup.service.runIfDue(ORG);
    expect(setup.sheets.get('Moses')).toMatchObject({ origin: 5, adoptedFrom: new Date('2026-11-17T00:00:00.000Z') });
    expect(microsoft.calls.some((call) => call.path.includes('/Moses/') && call.path.endsWith('/clear'))).toBe(false);
    expect(microsoft.shows('Moses', 'B3')).toBe('5 Before Rd - Zone 1');
    expect(setup.audits.filter((audit) => (audit as { action: string }).action === 'REVENUE_EXCEL_LOG_TAKEN_OVER')).toHaveLength(1);
  });

  it('takes over two tabs a run at most; the others wait, unwritten, for the next', async () => {
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft({ sheets: ['Amy', 'Kevin', 'Moses', 'Month of October'] });
    const setup = syncSetup({ startDate: '2026-11-17', logs: { amy: mosesLog(), kevin: mosesLog(), moses: mosesLog() } });
    const run = await setup.service.syncNow(office);
    const logTabs = run.tabs.map((tab) => tab.name).filter((name) => ['Amy', 'Kevin', 'Moses'].includes(name));
    expect(logTabs).toEqual(['Amy', 'Kevin']);
    // Left for a later run -- not one at once: the run says it left work, and the next reads as if Excel were edited.
    expect(setup.sync!.fileTag).toBeNull();
    expect(setup.sync!.dirtyAt).toEqual(new Date('2026-11-17T15:00:00.000Z'));
    expect(microsoft.calls.some((call) => call.path.includes('/Moses/'))).toBe(false);
  });
});

describe('the sync never runs on and on (2026-11-18: "couldn\'t merge your changes with changes from someone else")', () => {
  const at = new Date('2026-11-18T15:00:00.000Z');
  afterEach(() => jest.useRealTimers());
  const row = (date: string, over: Partial<RevenueLogRow>): RevenueLogRow => ({
    key: over.inspectionId ?? over.entryId ?? date,
    inspectionId: null,
    entryId: null,
    date,
    address: null, workOrder: null, jobNumber: null, driveTime: null, timeBudgeted: null, estimatedBudgetCents: null,
    arrival: null, leaving: null, workComplete: null, rescheduleRequired: null, rescheduleOn: null,
    laborCents: null, serviceCallFeeCents: null, materialsCents: null, invoiceNumber: null, postedInPw: null, notes: null,
    actualSeconds: null,
    filled: {},
    corrected: [],
    ...over,
  });
  const logDay = (date: string, rows: RevenueLogRow[]): RevenueLogDay => ({ date, rows, totals: revenueLogTotals(rows) });
  const FIRST = ['Ada', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jon', 'Kit'];
  const readTabs = (microsoft: ReturnType<typeof fakeMicrosoft>) =>
    microsoft.calls.flatMap((call) => {
      const used = /\/worksheets\/([^/]+)\/usedRange/.exec(call.path);
      return used ? [used[1]!] : [];
    });

  /** Eleven technicians, each with a visit today and a log tab taken over -- more than a run reads. */
  function eleven(extra: { name: string; days: RevenueLogDay[] }[] = []) {
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const people = [...FIRST.map((first, index) => ({ name: first, days: [logDay('2026-11-18', [row('2026-11-18', { inspectionId: `visit-${index}`, address: `${index + 1} Sample St`, jobNumber: String(21000 + index) })])] })), ...extra];
    people.forEach((person, index) => (NAMES[`tech-${index}`] = `${person.name} Sample`));
    const microsoft = fakeMicrosoft({ sheets: [...people.map((person) => person.name), 'Month of October'] });
    const setup = syncSetup({ startDate: '2026-11-18', logs: Object.fromEntries(people.map((person, index) => [`tech-${index}`, person.days])) });
    for (const person of people)
      setup.sheets.set(person.name, { name: person.name, organizationId: ORG, origin: 1, rows: [], bold: [], keys: [], editable: {}, adoptedFrom: new Date('2026-11-18T00:00:00.000Z'), formatsCheckedAt: new Date() });
    return { microsoft, setup };
  }

  it('reads the tabs read longest ago first, and comes back after a pause -- not a minute later -- for those it left', async () => {
    const { microsoft, setup } = eleven();
    await setup.service.syncNow(office);
    const first = readTabs(microsoft);
    expect(new Set(first).size).toBe(10);
    expect(setup.sync!.fileTag).toBeNull();
    const left = FIRST.find((name) => !first.includes(name))!;

    // A minute later: not due -- nothing of the console's waits on it.
    microsoft.calls.length = 0;
    jest.setSystemTime(new Date(at.getTime() + 60_000));
    expect(await setup.service.runIfDue(ORG)).toBeNull();
    expect(microsoft.calls).toEqual([]);

    // After the pause: the tab it left is read first.
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    await setup.service.runIfDue(ORG);
    expect(readTabs(microsoft)[0]).toBe(left);
  });

  it('never reads the tab of a technician with nothing on the log -- one who has left', async () => {
    const { microsoft, setup } = eleven([{ name: 'Old', days: [] }]);
    await setup.service.syncNow(office);
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    await setup.service.runIfDue(ORG);
    expect(readTabs(microsoft)).not.toContain('Old');
    expect(microsoft.calls.some((call) => call.path.includes('/Old/'))).toBe(false);
  });

  it("a run that only reads the office's edits opens no session on the workbook, and writes nothing", async () => {
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft();
    const setup = syncSetup({ remarks: 'Completed 3 visits' });
    await setup.service.syncNow(office);
    // The office types a cell the console leaves alone -- its title -- and a remark it already has.
    microsoft.edit('1117', 'H4', 'Completed 3 visits');
    microsoft.calls.length = 0;
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    await setup.service.runIfDue(ORG);
    expect(microsoft.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path.replace(/.*workbook\//, '')}`)).toEqual([]);
    expect(microsoft.writes()).toEqual([]);
  });

  it('with nothing changed, a later run writes nothing at all', async () => {
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    await setup.service.syncNow(office);
    microsoft.calls.length = 0;
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    expect(await setup.service.runIfDue(ORG)).toBeNull();
    expect(microsoft.writes()).toEqual([]);
  });
});

describe('an empty cell in Excel never empties the console (2026-11-17: Moses 17518)', () => {
  afterEach(() => jest.useRealTimers());

  it('leaves the cell empty in Excel, and takes nothing (2026-11-18: the spreadsheet is the source of truth)', async () => {
    const at = new Date('2026-11-17T15:00:00.000Z');
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft();
    const setup = syncSetup({ remarks: 'Drive time agreed with the office' });
    await setup.service.syncNow(office);
    // Excel shows the remark blank -- emptied there, or never reached it: either way the console keeps it.
    microsoft.edit('1117', 'H4', '');
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 0, putBack: 0, kept: 1 });
    expect(setup.saved).toEqual([]);
    expect(microsoft.shows('1117', 'H4')).toBe('');
  });

  it('still takes a value typed over one', async () => {
    const at = new Date('2026-11-17T15:00:00.000Z');
    jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const microsoft = fakeMicrosoft();
    const setup = syncSetup({ remarks: 'First' });
    await setup.service.syncNow(office);
    microsoft.edit('1117', 'H4', 'Second');
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ taken: 1 });
    expect(setup.saved).toEqual([expect.objectContaining({ table: 'day', dailyRemarks: 'Second' })]);
  });
});

describe("the office's formulas keep working (2026-11-18: \"='Amy'!E418\" showed as words)", () => {
  const at = new Date('2026-11-17T15:00:00.000Z');
  const timers = () => jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
  afterEach(() => jest.useRealTimers());

  it('writes words as General -- Text only where Excel would misread them -- and an empty cell never as Text', async () => {
    timers();
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    await setup.service.syncNow(office);
    const formats = microsoft.writes().flatMap((call) => {
      const body = call.body as { values: (string | number)[][]; numberFormat: string[][] };
      return body.values.flatMap((row, r) => row.map((value, c) => [value, body.numberFormat[r]![c]] as const));
    });
    expect(formats.filter(([value]) => value === '').every(([, format]) => format === 'General')).toBe(true);
    expect(formats.some(([, format]) => format === '@')).toBe(false);
    // A formula typed later into the drive time of the console's tracker works, as the office types it.
    microsoft.edit('New 1117', 'C4', "='Amy'!E418");
    expect(microsoft.cell('New 1117', 'C4')).toMatchObject({ formula: "='Amy'!E418" });
    // Every tab written this way has nothing to put right.
    expect([...setup.sheets.values()].every((sheet) => sheet.formatsCheckedAt)).toBe(true);
  });

  it("puts right the Text cells written before, once: a formula typed there is entered again, and remembered, never written over", async () => {
    timers();
    const microsoft = fakeMicrosoft({ sheets: ['Amy', 'Month of October', 'New 1117'] });
    const setup = syncSetup();
    // The tracker as v2.5.245-v2.5.250 left it: its drive times Text, an empty cell Text -- and the office's formula
    // typed into Amy's, kept by Excel as words; a WO# whose zero Text keeps.
    setup.sheets.set('New 1117', { name: 'New 1117', organizationId: ORG, rows: [['DATE:11/17/2026'], [''], ['Technician', 'Budget', 'Drive Time'], ['Amy Wilson', '', '60–95 min', '037826']], bold: [], keys: [null, null, null, 'day|amy|2026-11-17'], editable: {}, formatsCheckedAt: null });
    microsoft.edit('New 1117', 'A1', 'DATE:11/17/2026', '@');
    microsoft.edit('New 1117', 'B4', '', '@');
    microsoft.edit('New 1117', 'C4', "='Amy'!E418", '@');
    microsoft.edit('New 1117', 'D4', '037826', '@');
    expect(microsoft.cell('New 1117', 'C4')).toMatchObject({ value: "='Amy'!E418" });
    expect(microsoft.cell('New 1117', 'C4')!.formula).toBeUndefined();

    const repair = await setup.service.repairNow(office);
    expect(repair).toMatchObject({ tabs: 1, formulas: 1, waiting: 0 });
    expect(microsoft.cell('New 1117', 'C4')).toMatchObject({ formula: "='Amy'!E418", format: 'General' });
    expect(microsoft.cell('New 1117', 'B4')).toMatchObject({ format: 'General' });
    expect(microsoft.cell('New 1117', 'A1')).toMatchObject({ value: 'DATE:11/17/2026', format: 'General' });
    expect(microsoft.cell('New 1117', 'D4')).toMatchObject({ value: '037826', format: '@' });
    expect(setup.sheets.get('New 1117')).toMatchObject({ formulaCells: [[3, 2]] });
    expect(setup.sheets.get('New 1117')!.formatsCheckedAt).toBeTruthy();
    expect(setup.audits.at(-1)).toMatchObject({ action: 'EXCEL_FORMATS_REPAIRED', metadata: { tabs: 1, formulas: 1 } });
    // Once: pressed again, nothing is read.
    microsoft.calls.length = 0;
    expect(await setup.service.repairNow(office)).toMatchObject({ tabs: 0, cells: 0, formulas: 0 });
    expect(microsoft.calls.some((call) => call.path.includes('New 1117'))).toBe(false);
  });

  it("never writes over a formula the office put in one of the console's tabs, nor puts it back", async () => {
    timers();
    const microsoft = fakeMicrosoft();
    const setup = syncSetup();
    await setup.service.syncNow(office);
    // The office links Amy's projected revenue on the daily report to her log.
    microsoft.edit('1117', 'C4', '=Amy!G405');
    jest.setSystemTime(new Date(at.getTime() + 120_000));
    const run = await setup.service.runIfDue(ORG);
    expect(run!.pulled).toMatchObject({ putBack: 0 });
    expect(microsoft.cell('1117', 'C4')).toMatchObject({ formula: '=Amy!G405' });
    expect(setup.sheets.get('1117')).toMatchObject({ formulaCells: [[3, 2]] });
    // Later the console's projected revenue for Amy changes: everything else is written, never that cell.
    const snapshot = setup.sheets.get('1117')!;
    (snapshot.rows as unknown[][])[3]![2] = { value: 1, format: '"$"#,##0;-"$"#,##0' };
    await setup.db.excelSync.update({ data: { dirtyAt: new Date(at.getTime() + 180_000) } });
    microsoft.calls.length = 0;
    jest.setSystemTime(new Date(at.getTime() + 240_000));
    await setup.service.runIfDue(ORG);
    expect(microsoft.writes().some((call) => call.path.includes("1117/range(address='C4"))).toBe(false);
    expect(microsoft.cell('1117', 'C4')).toMatchObject({ formula: '=Amy!G405' });
  });
});
