import { randomBytes } from 'node:crypto';

import { UserRole } from '@texasrenters/shared';

import { sealSecret, readEnvelopeKey } from '../src/common/secret-envelope';
import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { XeroAuthService, authEventOf } from '../src/integrations/xero/xero-auth.service';
import { XeroClient } from '../src/integrations/xero/xero.client';
import { XERO_READ_SCOPES, XERO_SEND_SCOPES, getXeroConfig } from '../src/integrations/xero/xero.config';
import { XeroController } from '../src/integrations/xero/xero.controller';
import { XeroService, accountsFrom, taxRatesFrom } from '../src/integrations/xero/xero.service';

/**
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan):
 * connected once, read, never written. Every Xero host pinned, tokens sealed,
 * calls counted under a daily ceiling. Everything invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const ME = '90000000-0000-4000-8000-000000000030';
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

function database(row: Record<string, unknown> | null = null) {
  let stored = row ? { ...row } : null;
  const db = {
    xeroConnection: {
      findUnique: jest.fn(async () => stored),
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        stored = stored ? { ...stored, ...update } : { ...create };
        return stored;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = { ...stored, ...data };
        return stored;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!stored) return { count: 0 };
        // The daily count: a new day, or one more under the ceiling.
        if ('OR' in where && stored.callsDay === '2026-11-20') return { count: 0 };
        const under = where.callsUsed as { lt?: number } | undefined;
        if (under?.lt !== undefined && !((stored.callsUsed as number) < under.lt)) return { count: 0 };
        const next = { ...data };
        if (typeof (data.callsUsed as { increment?: number })?.increment === 'number')
          next.callsUsed = (stored.callsUsed as number) + (data.callsUsed as { increment: number }).increment;
        stored = { ...stored, ...next };
        return { count: 1 };
      }),
    },
    auditLog: { create: jest.fn() },
    row: () => stored,
  };
  return db;
}

const connected = (over: Record<string, unknown> = {}) => ({
  status: 'CONNECTED',
  xeroTenantId: 'tenant-1',
  xeroTenantName: 'Example Homes LLC',
  xeroConnectionId: 'conn-1',
  accessTokenCiphertext: sealSecret('access-1', key()),
  accessTokenExpiresAt: new Date('2026-11-20T18:20:00.000Z'),
  refreshTokenCiphertext: sealSecret('refresh-1', key()),
  callsDay: '2026-11-19',
  callsUsed: 0,
  catalogReadAt: null,
  ...over,
});

describe('the Xero app’s settings', () => {
  it('pins every Xero host, and asks to read settings and -- since phase 3 -- to write contacts, invoices and payments', () => {
    expect(() => getXeroConfig({ XERO_OAUTH_TOKEN_URL: 'https://identity.example.com/connect/token' })).toThrow('must be an HTTPS URL');
    expect(() => getXeroConfig({ XERO_API_URL: 'http://api.xero.com/api.xro/2.0' })).toThrow('must be an HTTPS URL');
    expect(getXeroConfig({}).scopes).toBe(XERO_SEND_SCOPES);
    expect(XERO_READ_SCOPES).toBe('offline_access accounting.settings.read');
    expect(getXeroConfig({ XERO_SCOPES: XERO_READ_SCOPES }).scopes).toBe(XERO_READ_SCOPES);
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
      scope: XERO_SEND_SCOPES,
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
    const db = database(connected({ accessTokenExpiresAt: new Date('2026-11-20T17:00:00.000Z') }));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 }));
    const auth = new XeroAuthService(db as never);
    const [first, second] = await Promise.all([auth.accessToken(ORG), auth.accessToken(ORG)]);
    expect([first, second]).toEqual(['access-2', 'access-2']);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Kept sealed, never as it came.
    expect(db.row()!.refreshTokenCiphertext).not.toContain('refresh-2');
  });

  it('asks for a new sign-in when Xero refuses the refresh token', async () => {
    const db = database(connected({ accessTokenExpiresAt: new Date('2026-11-20T17:00:00.000Z') }));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    await expect(new XeroAuthService(db as never).accessToken(ORG)).rejects.toMatchObject({ code: 'XERO_TOKEN_REFUSED' });
    expect(db.row()).toMatchObject({ status: 'REAUTHORIZATION_REQUIRED', accessTokenCiphertext: null });
  });
});

describe('calls to Xero', () => {
  const schema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

  it('sends the organisation with each call, and counts it', async () => {
    const db = database(connected());
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ Organisations: [] }));
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await client.get(ORG, '/Organisation', schema as never);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Organisation');
    expect((init!.headers as Record<string, string>)['xero-tenant-id']).toBe('tenant-1');
    expect(db.row()).toMatchObject({ callsDay: '2026-11-20', callsUsed: 1 });
  });

  it('stops at the console’s ceiling, before asking Xero', async () => {
    const db = database(connected({ callsDay: '2026-11-20', callsUsed: 300 }));
    const fetch = jest.spyOn(globalThis, 'fetch');
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await expect(client.get(ORG, '/Accounts', schema as never)).rejects.toMatchObject({ code: 'XERO_DAILY_CEILING', status: 429 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says how long Xero asked it to wait, and does not keep trying', async () => {
    const db = database(connected());
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 429, { 'retry-after': '120' }));
    const client = new XeroClient(db as never, new XeroAuthService(db as never));
    await expect(client.get(ORG, '/Accounts', schema as never)).rejects.toThrow('try again in 2 minutes');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('connecting the office’s organisation', () => {
  function service(row: Record<string, unknown> | null, tenants: unknown[]) {
    const db = database(row);
    const auth = new XeroAuthService(db as never);
    const client = new XeroClient(db as never, auth);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/connect/token')) return json({ access_token: jwt({ authentication_event_id: 'event-1' }), refresh_token: 'r', expires_in: 1800, scope: XERO_READ_SCOPES });
      if (url.endsWith('/connections')) return json(tenants);
      if (url.endsWith('/Organisation')) return json({ Organisations: [{ Name: 'Example Homes LLC', BaseCurrency: 'USD', CountryCode: 'US', SalesTaxBasis: 'NONE' }] });
      if (url.endsWith('/Accounts')) return json({ Accounts: [] });
      if (url.endsWith('/TaxRates')) return json({ TaxRates: [] });
      return json({}, 404);
    });
    return { db, xero: new XeroService(db as never, auth, client) };
  }
  const tenant = (id: string, event = 'event-1') => ({ id: `conn-${id}`, tenantId: id, tenantType: 'ORGANISATION', tenantName: `Org ${id}`, authEventId: event });
  const stateFor = () => new URL(new XeroAuthService(database() as never).authorizationUrl({ organizationId: ORG, userId: ME })).searchParams.get('state')!;

  it('keeps the one organisation chosen, reads it, and audits the connection', async () => {
    const { db, xero } = service(null, [tenant('tenant-1'), tenant('old', 'event-0')]);
    await expect(xero.completeAuthorization({ code: 'c', state: stateFor() })).resolves.toEqual({ name: 'Org tenant-1' });
    expect(db.row()).toMatchObject({ status: 'CONNECTED', xeroTenantId: 'tenant-1', xeroConnectionId: 'conn-tenant-1', connectedByUserId: ME });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'XERO_CONNECTED', organizationId: ORG });
    expect(db.row()!.organisation).toMatchObject({ name: 'Example Homes LLC', baseCurrency: 'USD' });
  });

  it('refuses two organisations at once, storing nothing', async () => {
    const { db, xero } = service(null, [tenant('tenant-1'), tenant('tenant-2')]);
    await expect(xero.completeAuthorization({ code: 'c', state: stateFor() })).rejects.toMatchObject({ code: 'XERO_ORGANISATION_CHOICE' });
    expect(db.row()).toBeNull();
  });

  it('refuses another organisation while one is connected: the books must not move without anybody seeing', async () => {
    const { db, xero } = service(connected({ xeroTenantId: 'tenant-1' }), [tenant('tenant-9')]);
    await expect(xero.completeAuthorization({ code: 'c', state: stateFor() })).rejects.toMatchObject({ code: 'XERO_ORGANISATION_MISMATCH' });
    expect(db.row()).toMatchObject({ xeroTenantId: 'tenant-1' });
  });

  it('reads again only every five minutes', async () => {
    const { xero } = service(connected({ catalogReadAt: new Date('2026-11-20T17:58:00.000Z') }), []);
    await expect(xero.read(ORG)).rejects.toMatchObject({ code: 'XERO_READ_TOO_SOON' });
  });

  it('ends the link at Xero, gives back the refresh token, and forgets the sign-in', async () => {
    const db = database(connected());
    const auth = new XeroAuthService(db as never);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    const result = await new XeroService(db as never, auth, new XeroClient(db as never, auth)).disconnect(office);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://api.xero.com/connections/conn-1', 'DELETE'],
      ['https://identity.xero.com/connect/revocation', 'POST'],
    ]);
    expect(result.removedAtXero).toBe(true);
    expect(db.row()).toMatchObject({ status: 'DISCONNECTED', accessTokenCiphertext: null, refreshTokenCiphertext: null, xeroConnectionId: null });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'XERO_DISCONNECTED' });
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
  it('reads with integrations:read; connects, reads again and disconnects with integrations:manage', () => {
    const permission = (name: keyof XeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, XeroController.prototype[name]);
    expect(permission('connection')).toEqual(['integrations:read']);
    expect(permission('authorize')).toEqual(['integrations:manage']);
    expect(permission('read')).toEqual(['integrations:manage']);
    expect(permission('disconnect')).toEqual(['integrations:manage']);
  });
});
