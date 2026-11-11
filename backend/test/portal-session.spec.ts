import { UserRole } from '@prisma/client';
import * as nock from 'nock';

import { portalTokenKey, readPortalConfig } from '../src/auth/portal/portal.config';
import { PortalClient } from '../src/auth/portal/portal.client';
import { PortalSessionService } from '../src/auth/portal/portal-session.service';
import { SessionService } from '../src/auth/session.service';
import { TokenService } from '../src/auth/token.service';
import { authenticateApplicationUser, setPortalSessionCheck } from '../src/common/auth';
import { openSecret } from '../src/common/secret-envelope';
import {
  ISSUER,
  MemoryPortalStore,
  ORG,
  PASSWORD,
  fakeDatabase,
  staffAccount,
  usePortalEnvironment,
  type AccountRow,
} from './support/portal';

/**
 * A portal session after sign-in: re-checked with the portal when a check is
 * due, ended when the portal says so, and kept through an outage.
 */

const MINUTE = 60_000;

function build(accounts: AccountRow[]) {
  const db = fakeDatabase(accounts);
  const store = new MemoryPortalStore();
  const client = new PortalClient();
  const tokens = new TokenService();
  const portalSessions = new PortalSessionService(store, client);
  const sessions = new SessionService(db.prisma as never, tokens, portalSessions);
  portalSessions.onModuleInit();
  return { db, store, client, tokens, portalSessions, sessions };
}

type Harness = ReturnType<typeof build>;

async function signedIn(harness: Harness, account: AccountRow) {
  const portalSessionId = harness.tokens.newPortalSessionId();
  const { accessTtlSeconds } = await harness.portalSessions.begin(portalSessionId, {
    authUserId: account.authUserId,
    subject: 'portal-sub-1',
    refreshToken: 'portal-refresh-1',
  });
  const session = await harness.sessions.issuePortalSession(account.authUserId, portalSessionId, accessTtlSeconds);
  return { portalSessionId, ...session };
}

/** Moves the last check back in time, as if that long had passed. */
function checkedAgo(harness: Harness, portalSessionId: string, ms: number) {
  harness.store.sessions.get(portalSessionId)!.checkedAt = Date.now() - ms;
}

const formBody = (body: unknown) =>
  typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : (body as Record<string, string>);

/** The portal's refresh grant. Counts the calls and records the token each one sent. */
function portalRefresh(status: number, body: Record<string, unknown> = {}, times = 1) {
  const sent: string[] = [];
  const scope = nock(ISSUER)
    .post('/oauth/token', (raw) => {
      const form = formBody(raw);
      if (form.grant_type !== 'refresh_token') return false;
      sent.push(form.refresh_token!);
      return true;
    })
    .times(times)
    .delay(30)
    .reply(status, body);
  return { scope, sent };
}

const ttlOf = (accessToken: string) => {
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()) as {
    exp: number;
    iat: number;
  };
  return claims.exp - claims.iat;
};

const sealedTokenOf = (harness: Harness, portalSessionId: string) =>
  openSecret(harness.store.sessions.get(portalSessionId)!.refreshToken, portalTokenKey(readPortalConfig().settings!));

beforeAll(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  setPortalSessionCheck(undefined);
});
afterAll(() => nock.enableNetConnect());

describe('re-checking a portal session', () => {
  usePortalEnvironment();

  it('does not ask the portal within the re-check window', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 2 * MINUTE);
    const portal = portalRefresh(200, { refresh_token: 'never' });

    const renewed = await harness.sessions.refresh(session.refreshToken);

    expect(portal.sent).toEqual([]);
    // Lives only until the check is due: three minutes left of five.
    expect(ttlOf(renewed.accessToken)).toBeGreaterThan(170);
    expect(ttlOf(renewed.accessToken)).toBeLessThanOrEqual(180);
    expect(harness.tokens.portalSessionIdOf(renewed.refreshToken)).toBe(session.portalSessionId);
  });

  it('refreshes at the portal once the window has passed, and keeps the rotated token', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 5 * MINUTE);
    const first = portalRefresh(200, { refresh_token: 'portal-refresh-2', access_token: 'a' });

    const renewed = await harness.sessions.refresh(session.refreshToken);

    expect(first.sent).toEqual(['portal-refresh-1']);
    expect(sealedTokenOf(harness, session.portalSessionId)).toBe('portal-refresh-2');
    expect(ttlOf(renewed.accessToken)).toBe(300);
    expect(harness.store.sessions.get(session.portalSessionId)!.checkedAt).toBeGreaterThan(Date.now() - 1_000);

    // The next check sends the new token, never the rotated-away one.
    checkedAgo(harness, session.portalSessionId, 6 * MINUTE);
    const second = portalRefresh(200, { refresh_token: 'portal-refresh-3' });
    await harness.sessions.refresh(renewed.refreshToken);
    expect(second.sent).toEqual(['portal-refresh-2']);
  });

  it('asks at the console’s own renewal, a minute before the window closes', async () => {
    // The console renews 60 s before expiry. Asking then is what keeps every
    // request inside five minutes of a check.
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 4 * MINUTE + 5_000);
    const portal = portalRefresh(200, { refresh_token: 'portal-refresh-2' });

    await harness.sessions.refresh(session.refreshToken);
    expect(portal.sent).toEqual(['portal-refresh-1']);
  });

  it.each([
    ['400 invalid_grant', 400, { error: 'invalid_grant' }],
    ['401', 401, { error: 'invalid_client' }],
  ])('signs the person out when the portal answers %s', async (_label, status, body) => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 6 * MINUTE);
    portalRefresh(status, body);

    await expect(harness.sessions.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'PORTAL_SESSION_ENDED',
      status: 401,
    });
    // The session is gone here and there, and its access token is refused at once.
    expect(harness.store.sessions.has(session.portalSessionId)).toBe(false);
    expect(harness.db.refreshTokens[0]!.revokedAt).toBeInstanceOf(Date);
    await expect(
      authenticateApplicationUser(harness.db.prisma as never, session.accessToken),
    ).rejects.toMatchObject({ code: 'PORTAL_SESSION_ENDED' });
    // And it stays ended: the next renewal is refused without asking the portal.
    const again = portalRefresh(200, { refresh_token: 'x' });
    await expect(harness.sessions.refresh(session.refreshToken)).rejects.toBeDefined();
    expect(again.sent).toEqual([]);
  });

  it.each([
    ['a network error', () => nock(ISSUER).post('/oauth/token').replyWithError({ code: 'ECONNRESET' })],
    ['a 500', () => nock(ISSUER).post('/oauth/token').reply(500)],
    ['a 503', () => nock(ISSUER).post('/oauth/token').reply(503, 'Service Unavailable')],
    ['an unexpected 400', () => nock(ISSUER).post('/oauth/token').reply(400, { error: 'invalid_request' })],
  ])('keeps the person signed in through %s, and asks again on the next renewal', async (_label, outage) => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 6 * MINUTE);
    const before = harness.store.sessions.get(session.portalSessionId)!;
    outage();

    const renewed = await harness.sessions.refresh(session.refreshToken);

    // About a minute, so the console comes back soon without asking on every request.
    expect(ttlOf(renewed.accessToken)).toBe(120);
    expect(harness.store.sessions.get(session.portalSessionId)).toEqual(before);
    await expect(
      authenticateApplicationUser(harness.db.prisma as never, renewed.accessToken),
    ).resolves.toMatchObject({ authUserId: account.authUserId });

    const recovered = portalRefresh(200, { refresh_token: 'portal-refresh-2' });
    await harness.sessions.refresh(renewed.refreshToken);
    expect(recovered.sent).toEqual(['portal-refresh-1']);
  });

  it('keeps the person signed in when the portal does not answer within the timeout', async () => {
    const account = staffAccount();
    const harness = build([account]);
    harness.client.timeoutMs = 50;
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 6 * MINUTE);
    nock(ISSUER).post('/oauth/token').delay(500).reply(200, { refresh_token: 'late' });

    const renewed = await harness.sessions.refresh(session.refreshToken);
    expect(ttlOf(renewed.accessToken)).toBe(120);
    expect(sealedTokenOf(harness, session.portalSessionId)).toBe('portal-refresh-1');
  });

  it('keeps the person signed in while the session store is unreachable', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    harness.store.unavailable = true;
    const portal = portalRefresh(200, { refresh_token: 'never' });

    const renewed = await harness.sessions.refresh(session.refreshToken);
    expect(ttlOf(renewed.accessToken)).toBe(120);
    expect(portal.sent).toEqual([]);
    await expect(
      authenticateApplicationUser(harness.db.prisma as never, renewed.accessToken),
    ).resolves.toBeDefined();
  });

  it('ends a session whose record is gone, as after a Redis restart', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    harness.store.sessions.clear();

    await expect(harness.sessions.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'PORTAL_SESSION_ENDED',
    });
  });

  it('refreshes once when two renewals arrive together at the five-minute mark', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 5 * MINUTE);
    // Two answers available: if both renewals asked, both would be used.
    const portal = portalRefresh(200, { refresh_token: 'portal-refresh-2' }, 2);

    const [one, two] = await Promise.all([
      harness.sessions.refresh(session.refreshToken),
      harness.sessions.refresh(session.refreshToken),
    ]);

    expect(portal.sent).toEqual(['portal-refresh-1']);
    expect(sealedTokenOf(harness, session.portalSessionId)).toBe('portal-refresh-2');
    for (const renewed of [one, two]) {
      expect(ttlOf(renewed.accessToken)).toBeGreaterThan(200);
      await expect(
        authenticateApplicationUser(harness.db.prisma as never, renewed.accessToken),
      ).resolves.toMatchObject({ authUserId: account.authUserId });
    }
    expect(harness.store.locks.size).toBe(0);
  });

  it('never asks the portal on ordinary requests, however many arrive at the five-minute mark', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    checkedAgo(harness, session.portalSessionId, 5 * MINUTE);
    const portal = portalRefresh(200, { refresh_token: 'never' }, 5);

    const users = await Promise.all(
      Array.from({ length: 5 }, () => authenticateApplicationUser(harness.db.prisma as never, session.accessToken)),
    );
    expect(users.map((user) => user.authUserId)).toEqual(Array(5).fill(account.authUserId));
    expect(portal.sent).toEqual([]);
  });

  it('never uses another session’s portal token', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const mine = await signedIn(harness, account);
    const theirs = await signedIn(harness, account);
    checkedAgo(harness, mine.portalSessionId, 6 * MINUTE);
    const portal = portalRefresh(200, { refresh_token: 'mine-2' });

    await harness.sessions.refresh(mine.refreshToken);
    expect(portal.sent).toEqual(['portal-refresh-1']);
    expect(sealedTokenOf(harness, mine.portalSessionId)).toBe('mine-2');
    expect(sealedTokenOf(harness, theirs.portalSessionId)).toBe('portal-refresh-1');
  });
});

describe('the request check', () => {
  usePortalEnvironment();

  it('refuses a portal token when no check is registered: it fails closed', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);
    setPortalSessionCheck(undefined);
    await expect(
      authenticateApplicationUser(harness.db.prisma as never, session.accessToken),
    ).rejects.toMatchObject({ code: 'PORTAL_SESSION_ENDED' });
  });

  it('refuses a portal token whose session belongs to someone else', async () => {
    const account = staffAccount();
    const harness = build([account, staffAccount({ authUserId: 'auth-other' })]);
    const session = await signedIn(harness, account);
    harness.store.sessions.get(session.portalSessionId)!.authUserId = 'auth-other';
    await expect(
      authenticateApplicationUser(harness.db.prisma as never, session.accessToken),
    ).rejects.toMatchObject({ code: 'PORTAL_SESSION_ENDED' });
  });

  it('ends the session on sign-out here, and says where to go next', async () => {
    const account = staffAccount();
    const harness = build([account]);
    const session = await signedIn(harness, account);

    await expect(harness.sessions.signOut(session.refreshToken)).resolves.toEqual({
      signedOutUrl: `${ISSUER}/dashboard`,
    });
    expect(harness.store.sessions.has(session.portalSessionId)).toBe(false);
    await expect(
      authenticateApplicationUser(harness.db.prisma as never, session.accessToken),
    ).rejects.toMatchObject({ code: 'PORTAL_SESSION_ENDED' });
  });
});

describe('password sign-in once staff use the portal', () => {
  const technician = () =>
    staffAccount({
      email: 'tech@texasrenters.com',
      memberships: [{ organizationId: ORG, role: UserRole.INSPECTION_TECHNICIAN }],
      roleAssignments: [],
    });

  describe('with PORTAL_ALLOW_PASSWORD_LOGIN=true', () => {
    usePortalEnvironment();

    it('signs staff in to the console with a password, as before', async () => {
      const account = staffAccount();
      const harness = build([account]);
      await expect(harness.sessions.signIn(account.email, PASSWORD, { client: 'console' })).resolves.toMatchObject({
        accessToken: expect.any(String),
      });
    });
  });

  describe('with PORTAL_ALLOW_PASSWORD_LOGIN=false', () => {
    usePortalEnvironment({ PORTAL_ALLOW_PASSWORD_LOGIN: 'false' });

    it('refuses staff on the console with the same answer as a wrong password', async () => {
      const account = staffAccount();
      const harness = build([account]);
      const refused = await harness.sessions.signIn(account.email, PASSWORD, { client: 'console' }).catch((e) => e);
      const wrong = await harness.sessions.signIn(account.email, 'wrong-password', { client: 'console' }).catch((e) => e);
      expect(refused).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
      expect(refused.message).toBe(wrong.message);
      expect(harness.db.refreshTokens).toEqual([]);
    });

    it('never affects anyone who is not staff', async () => {
      const account = technician();
      const harness = build([account]);
      await expect(harness.sessions.signIn(account.email, PASSWORD, { client: 'console' })).resolves.toBeDefined();
    });

    it('never affects the phone, even for staff', async () => {
      const account = staffAccount();
      const harness = build([account]);
      await expect(harness.sessions.signIn(account.email, PASSWORD)).resolves.toBeDefined();
    });

    it('ends a staff console password session at its next renewal, but not a phone one', async () => {
      const account = staffAccount();
      const harness = build([account]);
      const create = (fromConsole: boolean) => {
        const token = harness.tokens.createRefreshToken();
        void harness.db.prisma.authRefreshToken.create({
          data: {
            authUserId: account.authUserId,
            tokenHash: token.tokenHash,
            expiresAt: token.expiresAt,
            deviceId: null,
            fromConsole,
          },
        });
        return token.token;
      };
      const consoleToken = create(true);
      const phoneToken = create(false);

      await expect(harness.sessions.refresh(consoleToken, { client: 'console' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
      await expect(harness.sessions.refresh(phoneToken)).resolves.toBeDefined();
    });
  });

  describe('with the portal switched off, PORTAL_ALLOW_PASSWORD_LOGIN=false means nothing', () => {
    usePortalEnvironment({ PORTAL_ENABLED: 'false', PORTAL_ALLOW_PASSWORD_LOGIN: 'false' });

    it('signs staff in to the console with a password, and reads nothing extra to do it', async () => {
      const account = staffAccount();
      const harness = build([account]);
      await expect(harness.sessions.signIn(account.email, PASSWORD, { client: 'console' })).resolves.toBeDefined();
      expect(harness.db.prisma.userProfile.findUnique).not.toHaveBeenCalled();
    });
  });
});
