import { randomBytes } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

import { sealSecret, readEnvelopeKey } from '../src/common/secret-envelope';
import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { XeroAuthService, authEventOf } from '../src/integrations/xero/xero-auth.service';
import { XeroClient } from '../src/integrations/xero/xero.client';
import { XERO_READ_SCOPES, getXeroConfig } from '../src/integrations/xero/xero.config';
import { XeroController } from '../src/integrations/xero/xero.controller';
import { XeroService, accountsFrom, taxRatesFrom } from '../src/integrations/xero/xero.service';

/**
 * The office's Xero organisations (2026-11-10): one sign-in reaching each of
 * the companies' books, each read and counted on its own, never written. Every
 * Xero host pinned, tokens sealed. Everything invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const ME = '90000000-0000-4000-8000-000000000030';
const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';
const AIR = 'a3000000-0000-4000-8000-000000000003';
const office: AuthenticatedUser = {
  id: ME,
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['integrations:read', 'integrations:manage'],
  mustChangePassword: false,
  principalType: 'USER',
};

const KEY_HEX = randomBytes(32).toString('hex');
const key = () => readEnvelopeKey(KEY_HEX, 'XERO_TOKEN_ENCRYPTION_KEY')!;

/** An access token as Xero makes them: a JWT whose body names the sign-in. */
const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  process.env.XERO_CLIENT_ID = 'client-123';
  process.env.XERO_CLIENT_SECRET = 'not-a-real-secret';
  process.env.XERO_OAUTH_REDIRECT_URI = 'https://console.example.com/api/v1/integrations/xero/oauth/callback';
  process.env.XERO_TOKEN_ENCRYPTION_KEY = KEY_HEX;
  delete process.env.XERO_DAILY_CALL_CEILING;
  delete process.env.XERO_SCOPES;
  jest.useFakeTimers({
    now: new Date('2026-11-20T18:00:00.000Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Row = Record<string, unknown>;

/** Enough of Prisma's `where` for these tests: equals, not, notIn, lt and OR. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    if (field === 'OR') return (wanted as Row[]).some((branch) => matches(row, branch));
    const value = row[field] ?? null;
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      const test = wanted as { not?: unknown; notIn?: unknown[]; lt?: number };
      if ('not' in test) return value !== test.not;
      if ('notIn' in test) return !test.notIn!.includes(value);
      if ('lt' in test) return typeof value === 'number' && value < test.lt!;
    }
    return value === wanted;
  });
}

function database(connection: Row | null = null, organisations: Row[] = []) {
  let stored = connection ? { ...connection } : null;
  const rows: Row[] = organisations.map((row) => ({ organizationId: ORG, status: 'CONNECTED', callsDay: null, callsUsed: 0, catalogReadAt: null, ...row }));
  const find = (key: { organizationId: string; xeroTenantId: string }) =>
    rows.find((row) => row.organizationId === key.organizationId && row.xeroTenantId === key.xeroTenantId);
  const apply = (row: Row, data: Row) => {
    for (const [field, value] of Object.entries(data))
      row[field] = value && typeof value === 'object' && 'increment' in value ? (row[field] as number) + (value as { increment: number }).increment : value;
  };
  const db = {
    xeroConnection: {
      findUnique: jest.fn(async () => stored),
      upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => {
        stored = stored ? { ...stored, ...update } : { ...create };
        return stored;
      }),
      updateMany: jest.fn(async ({ data }: { data: Row }) => {
        if (!stored) return { count: 0 };
        stored = { ...stored, ...data };
        return { count: 1 };
      }),
    },
    xeroOrganisation: {
      findUnique: jest.fn(async ({ where }: { where: { organizationId_xeroTenantId: { organizationId: string; xeroTenantId: string } } }) =>
        find(where.organizationId_xeroTenantId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        rows.filter((row) => matches(row, where)).sort((a, b) => String(a.status).localeCompare(String(b.status)) || String(a.name).localeCompare(String(b.name))),
      ),
      upsert: jest.fn(async ({ where, create, update }: { where: { organizationId_xeroTenantId: { organizationId: string; xeroTenantId: string } }; create: Row; update: Row }) => {
        const row = find(where.organizationId_xeroTenantId);
        if (row) apply(row, update);
        else rows.push({ callsDay: null, callsUsed: 0, catalogReadAt: null, ...create });
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { organizationId_xeroTenantId: { organizationId: string; xeroTenantId: string } }; data: Row }) => {
        const row = find(where.organizationId_xeroTenantId)!;
        apply(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) apply(row, data);
        return { count: hit.length };
      }),
    },
    auditLog: { create: jest.fn() },
    connection: () => stored,
    organisation: (tenantId: string) => find({ organizationId: ORG, xeroTenantId: tenantId }),
    organisations: () => rows,
  };
  return db;
}

const signedIn = (over: Row = {}) => ({
  status: 'CONNECTED',
  accessTokenCiphertext: sealSecret('access-1', key()),
  accessTokenExpiresAt: new Date('2026-11-20T18:20:00.000Z'),
  refreshTokenCiphertext: sealSecret('refresh-1', key()),
  ...over,
});

describe('the Xero app’s settings', () => {
  it('pins every Xero host, and asks only to read in this phase', () => {
    expect(() => getXeroConfig({ XERO_OAUTH_TOKEN_URL: 'https://identity.example.com/connect/token' })).toThrow('must be an HTTPS URL');
    expect(() => getXeroConfig({ XERO_API_URL: 'http://api.xero.com/api.xro/2.0' })).toThrow('must be an HTTPS URL');
    expect(getXeroConfig({}).scopes).toBe(XERO_READ_SCOPES);
    expect(XERO_READ_SCOPES).toBe('offline_access accounting.settings.read');
  });

  it('never lets the daily ceiling pass Xero’s own 1,000', () => {
    expect(getXeroConfig({}).dailyCallCeiling).toBe(300);
    expect(getXeroConfig({ XERO_DAILY_CALL_CEILING: '5000' }).dailyCallCeiling).toBe(1000);
    expect(getXeroConfig({ XERO_DAILY_CALL_CEILING: 'lots' }).dailyCallCeiling).toBe(300);
  });
});

describe('signing in to Xero', () => {
  it('sends the person to Xero with PKCE and a sealed state, and opens the state again on the way back', () => {
    const auth = new XeroAuthService(database() as never);
    const url = new URL(auth.authorizationUrl({ organizationId: ORG, userId: ME }));
    expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      scope: XERO_READ_SCOPES,
      code_challenge_method: 'S256',
      redirect_uri: process.env.XERO_OAUTH_REDIRECT_URI,
    });
    const state = auth.readState(url.searchParams.get('state')!);
    expect(state).toMatchObject({ organizationId: ORG, userId: ME });
    // The verifier never travels in the clear.
    expect(url.toString()).not.toContain(state.codeVerifier);
  });

  it('refuses a state it cannot open, and one that has waited too long', () => {
    const auth = new XeroAuthService(database() as never);
    expect(() => auth.readState('forged')).toThrow('could not be checked');
    const url = new URL(auth.authorizationUrl({ organizationId: ORG, userId: ME }));
    jest.setSystemTime(new Date('2026-11-20T18:11:00.000Z'));
    expect(() => auth.readState(url.searchParams.get('state')!)).toThrow('took too long');
  });

  it('is refused when the server has no Xero app', () => {
    delete process.env.XERO_CLIENT_SECRET;
    expect(() => new XeroAuthService(database() as never).authorizationUrl({ organizationId: ORG, userId: ME })).toThrow('not set up on this server');
  });

  it('trades the code for tokens with the app’s own credentials, and needs a refresh token', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ access_token: 'a', refresh_token: 'r', expires_in: 1800 }));
    await new XeroAuthService(database() as never).exchange('code-1', 'verifier-1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://identity.xero.com/connect/token');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('client-123:not-a-real-secret').toString('base64')}`);
    expect(String(init!.body)).toContain('code_verifier=verifier-1');

    fetch.mockResolvedValue(json({ access_token: 'a', expires_in: 1800 }));
    await expect(new XeroAuthService(database() as never).exchange('code-2', 'v')).rejects.toMatchObject({ code: 'XERO_NO_REFRESH_TOKEN' });
  });

  it('reads which sign-in a token came from', () => {
    expect(authEventOf(jwt({ authentication_event_id: 'event-1' }))).toBe('event-1');
    expect(authEventOf('not-a-jwt')).toBeNull();
  });
});

describe('the stored sign-in', () => {
  it('refreshes once for two callers at once: Xero spends a refresh token on its first use', async () => {
    const db = database(signedIn({ accessTokenExpiresAt: new Date('2026-11-20T17:00:00.000Z') }));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 }));
    const auth = new XeroAuthService(db as never);
    const [first, second] = await Promise.all([auth.accessToken(ORG), auth.accessToken(ORG)]);
    expect([first, second]).toEqual(['access-2', 'access-2']);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Kept sealed, never as it came.
    expect(db.connection()!.refreshTokenCiphertext).not.toContain('refresh-2');
  });

  it('asks for a new sign-in when Xero refuses the refresh token', async () => {
    const db = database(signedIn({ accessTokenExpiresAt: new Date('2026-11-20T17:00:00.000Z') }));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    await expect(new XeroAuthService(db as never).accessToken(ORG)).rejects.toMatchObject({ code: 'XERO_TOKEN_REFUSED' });
    expect(db.connection()).toMatchObject({ status: 'REAUTHORIZATION_REQUIRED', accessTokenCiphertext: null });
  });
});

describe('calls to Xero', () => {
  const schema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
  const two = () =>
    database(signedIn(), [
      { xeroTenantId: HOMES, name: 'Example Home Services', callsDay: '2026-11-19', callsUsed: 0 },
      { xeroTenantId: PEST, name: 'Example Pest Co', callsDay: '2026-11-20', callsUsed: 300 },
    ]);

  it('names the organisation on each call, and counts it against that organisation alone', async () => {
    const db = two();
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ Organisations: [] }));
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await client.get(ORG, HOMES, '/Organisation', schema as never);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Organisation');
    expect((init!.headers as Record<string, string>)['xero-tenant-id']).toBe(HOMES);
    expect(db.organisation(HOMES)).toMatchObject({ callsDay: '2026-11-20', callsUsed: 1 });
    expect(db.organisation(PEST)).toMatchObject({ callsUsed: 300 });
  });

  it('stops one organisation at the console’s ceiling, before asking Xero, while another goes on', async () => {
    const db = two();
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ Accounts: [] }));
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await expect(client.get(ORG, PEST, '/Accounts', schema as never)).rejects.toMatchObject({ code: 'XERO_DAILY_CEILING', status: 429 });
    expect(fetch).not.toHaveBeenCalled();
    await client.get(ORG, HOMES, '/Accounts', schema as never);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks nothing of an organisation that is not connected', async () => {
    const db = database(signedIn(), [{ xeroTenantId: AIR, name: 'Example Air Co', status: 'REMOVED' }]);
    const fetch = jest.spyOn(globalThis, 'fetch');
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await expect(client.get(ORG, AIR, '/Accounts', schema as never)).rejects.toMatchObject({ code: 'XERO_NOT_CONNECTED' });
    await expect(client.get(ORG, 'unknown', '/Accounts', schema as never)).rejects.toMatchObject({ code: 'XERO_NOT_CONNECTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says how long Xero asked it to wait, and does not keep trying', async () => {
    const db = two();
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 429, { 'retry-after': '120' }));
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await expect(client.get(ORG, HOMES, '/Accounts', schema as never)).rejects.toThrow('try again in 2 minutes');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('connecting the office’s organisations', () => {
  function service(connection: Row | null, organisations: Row[], tenants: unknown[]) {
    const db = database(connection, organisations);
    const auth = new XeroAuthService(db as never);
    const client = new XeroClient(db as never, auth);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const tenant = (init?.headers as Record<string, string> | undefined)?.['xero-tenant-id'];
      if (url.endsWith('/connect/token')) return json({ access_token: jwt({ authentication_event_id: 'event-1' }), refresh_token: 'r', expires_in: 1800, scope: XERO_READ_SCOPES });
      if (url.endsWith('/connections')) return json(tenants);
      if (url.endsWith('/Organisation')) return json({ Organisations: [{ Name: `Read ${tenant?.slice(0, 2)}`, BaseCurrency: 'USD', CountryCode: 'US', SalesTaxBasis: 'NONE' }] });
      if (url.endsWith('/Accounts')) return json({ Accounts: [] });
      if (url.endsWith('/TaxRates')) return json({ TaxRates: [] });
      return json({}, 404);
    });
    return { db, fetch, xero: new XeroService(db as never, auth, client) };
  }
  const tenant = (id: string, name: string) => ({ id: `conn-${id.slice(0, 2)}`, tenantId: id, tenantType: 'ORGANISATION', tenantName: name, authEventId: 'event-1' });
  const stateFor = () => new URL(new XeroAuthService(database() as never).authorizationUrl({ organizationId: ORG, userId: ME })).searchParams.get('state')!;

  it('keeps every organisation ticked, reads each on its own, and audits the connection', async () => {
    const { db, xero, fetch } = service(null, [], [tenant(HOMES, 'Example Home Services'), tenant(PEST, 'Example Pest Co'), tenant(AIR, 'Example Air Co')]);
    await expect(xero.completeAuthorization({ code: 'c', state: stateFor() })).resolves.toEqual({
      names: ['Example Home Services', 'Example Pest Co', 'Example Air Co'],
    });
    expect(db.connection()).toMatchObject({ status: 'CONNECTED', connectedByUserId: ME });
    expect(db.organisations().map((row) => [row.xeroTenantId, row.status, row.xeroConnectionId])).toEqual([
      [HOMES, 'CONNECTED', 'conn-a1'],
      [PEST, 'CONNECTED', 'conn-a2'],
      [AIR, 'CONNECTED', 'conn-a3'],
    ]);
    // Three calls to each organisation, each counted against it.
    for (const id of [HOMES, PEST, AIR]) expect(db.organisation(id)).toMatchObject({ callsUsed: 3, organisation: expect.objectContaining({ baseCurrency: 'USD' }) });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/api.xro/'))).toHaveLength(9);
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'XERO_CONNECTED',
      metadata: { organisations: ['Example Home Services', 'Example Pest Co', 'Example Air Co'], noLongerReached: 0 },
    });
  });

  it('adds one ticked later, and marks removed -- never deleted -- one the sign-in no longer reaches', async () => {
    const { db, xero } = service(
      signedIn(),
      [
        { xeroTenantId: HOMES, name: 'Example Home Services' },
        { xeroTenantId: PEST, name: 'Example Pest Co' },
      ],
      [tenant(HOMES, 'Example Home Services'), tenant(AIR, 'Example Air Co')],
    );
    await xero.completeAuthorization({ code: 'c', state: stateFor() });
    expect(db.organisation(PEST)).toMatchObject({ status: 'REMOVED', xeroConnectionId: null, removedAt: expect.any(Date) });
    expect(db.organisation(AIR)).toMatchObject({ status: 'CONNECTED' });
    expect(db.organisation(HOMES)).toMatchObject({ status: 'CONNECTED' });
  });

  it('connects nothing when no organisation was ticked', async () => {
    const { db, xero } = service(null, [], [{ id: 'conn-p', tenantId: 'practice-1', tenantType: 'PRACTICEMANAGER' }]);
    await expect(xero.completeAuthorization({ code: 'c', state: stateFor() })).rejects.toMatchObject({ code: 'XERO_ORGANISATION_CHOICE' });
    expect(db.connection()).toBeNull();
  });

  it('lists the organisations, connected first, each with its own calls today', async () => {
    const { xero } = service(
      signedIn(),
      [
        { xeroTenantId: PEST, name: 'Example Pest Co', callsDay: '2026-11-20', callsUsed: 7 },
        { xeroTenantId: AIR, name: 'Example Air Co', status: 'REMOVED' },
        { xeroTenantId: HOMES, name: 'Example Home Services', callsDay: '2026-11-19', callsUsed: 40 },
      ],
      [],
    );
    const view = await xero.describe(ORG);
    expect(view.organisations.map((item) => [item.name, item.status, item.callsToday])).toEqual([
      ['Example Home Services', 'CONNECTED', 0],
      ['Example Pest Co', 'CONNECTED', 7],
      ['Example Air Co', 'REMOVED', 0],
    ]);
    expect(view.dailyCeiling).toBe(300);
  });

  it('reads one organisation again only every five minutes, and not one it does not have', async () => {
    const { xero } = service(signedIn(), [{ xeroTenantId: HOMES, name: 'Example Home Services', catalogReadAt: new Date('2026-11-20T17:58:00.000Z') }], []);
    await expect(xero.read(ORG, HOMES)).rejects.toMatchObject({ code: 'XERO_READ_TOO_SOON' });
    await expect(xero.read(ORG, PEST)).rejects.toMatchObject({ code: 'XERO_ORGANISATION_UNKNOWN', status: 404 });
  });

  it('disconnects one organisation at Xero, keeping the others', async () => {
    const db = database(signedIn(), [
      { xeroTenantId: HOMES, name: 'Example Home Services', xeroConnectionId: 'conn-a1' },
      { xeroTenantId: PEST, name: 'Example Pest Co', xeroConnectionId: 'conn-a2' },
    ]);
    const auth = new XeroAuthService(db as never);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    const result = await new XeroService(db as never, auth, new XeroClient(db as never, auth)).disconnectOrganisation(office, PEST);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([['https://api.xero.com/connections/conn-a2', 'DELETE']]);
    expect(result.removedAtXero).toBe(true);
    expect(db.organisation(PEST)).toMatchObject({ status: 'REMOVED' });
    expect(db.organisation(HOMES)).toMatchObject({ status: 'CONNECTED' });
    expect(db.connection()).toMatchObject({ status: 'CONNECTED' });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'XERO_ORGANISATION_DISCONNECTED', metadata: { name: 'Example Pest Co' } });
  });

  it('ends every link at Xero, gives back the refresh token, and forgets the sign-in', async () => {
    const db = database(signedIn(), [
      { xeroTenantId: HOMES, name: 'Example Home Services', xeroConnectionId: 'conn-a1' },
      { xeroTenantId: PEST, name: 'Example Pest Co', xeroConnectionId: 'conn-a2' },
    ]);
    const auth = new XeroAuthService(db as never);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    const result = await new XeroService(db as never, auth, new XeroClient(db as never, auth)).disconnect(office);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://api.xero.com/connections/conn-a1', 'DELETE'],
      ['https://api.xero.com/connections/conn-a2', 'DELETE'],
      ['https://identity.xero.com/connect/revocation', 'POST'],
    ]);
    expect(result.removedAtXero).toBe(true);
    expect(db.connection()).toMatchObject({ status: 'DISCONNECTED', accessTokenCiphertext: null, refreshTokenCiphertext: null });
    expect(db.organisations().map((row) => row.status)).toEqual(['REMOVED', 'REMOVED']);
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'XERO_DISCONNECTED', metadata: { organisations: 2 } });
  });
});

describe('what is read', () => {
  it('keeps the accounts by code, knowing which take payments', () => {
    const accounts = accountsFrom({
      Accounts: [
        { AccountID: 'a2', Code: '400', Name: 'Service revenue', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
        { AccountID: 'a1', Code: null, Name: 'Operating checking', Type: 'BANK', Class: 'ASSET', Status: 'ACTIVE' },
        { AccountID: 'a3', Code: '610', Name: 'Owner funds clearing', Type: 'CURRLIAB', Class: 'LIABILITY', Status: 'ACTIVE', EnablePaymentsToAccount: true },
      ],
    });
    expect(accounts.map((account) => [account.code, account.takesPayments])).toEqual([
      ['400', false],
      ['610', true],
      [null, true],
    ]);
    expect(taxRatesFrom({ TaxRates: [{ Name: 'Tax Exempt', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: '0.00' }] })[0]).toMatchObject({ effectiveRate: 0 });
  });
});

describe('who may do what', () => {
  const permission = (name: keyof XeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, XeroController.prototype[name]);

  it('reads with integrations:read; connects, reads again and disconnects with integrations:manage', () => {
    expect(permission('connection')).toEqual(['integrations:read']);
    expect(permission('readSettings')).toEqual(['integrations:read']);
    for (const name of ['authorize', 'read', 'disconnect', 'disconnectOrganisation', 'saveSettings'] as const)
      expect(permission(name)).toEqual(['integrations:manage']);
  });

  it('names an organisation only by Xero’s own id', async () => {
    const controller = new XeroController({ read: jest.fn() } as never, {} as never, {} as never);
    expect(() => controller.read({ user: office } as never, '../connections')).toThrow('not one of the office’s Xero organisations');
  });
});
