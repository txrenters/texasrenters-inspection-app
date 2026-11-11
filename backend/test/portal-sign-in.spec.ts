import { createHash } from 'node:crypto';

import { UserRole } from '@prisma/client';
import * as nock from 'nock';

import { portalTokenKey, readPortalConfig } from '../src/auth/portal/portal.config';
import { PortalClient } from '../src/auth/portal/portal.client';
import { PortalSessionService } from '../src/auth/portal/portal-session.service';
import { PortalSignInService, safeReturnTo } from '../src/auth/portal/portal-sign-in.service';
import { SessionService } from '../src/auth/session.service';
import { TokenService } from '../src/auth/token.service';
import { openSecret } from '../src/common/secret-envelope';
import {
  APP_SLUG,
  CLIENT_ID,
  CLIENT_SECRET,
  ISSUER,
  MemoryPortalStore,
  ORG,
  fakeDatabase,
  staffAccount,
  usePortalEnvironment,
  type AccountRow,
} from './support/portal';

/**
 * Sign in with TR Staff Portal: from the redirect out to the session issued
 * when the portal sends the person back. The portal is mocked over HTTP.
 */

const SUBJECT = '6f1c2d3e-4b5a-4968-8776-5a4b3c2d1e0f';

function build(accounts: AccountRow[]) {
  const db = fakeDatabase(accounts);
  const store = new MemoryPortalStore();
  const client = new PortalClient();
  const tokens = new TokenService();
  const portalSessions = new PortalSessionService(store, client);
  const sessions = new SessionService(db.prisma as never, tokens, portalSessions);
  const signIn = new PortalSignInService(db.prisma as never, store, client, sessions, portalSessions, tokens);
  return { db, store, tokens, portalSessions, sessions, signIn };
}

type Harness = ReturnType<typeof build>;

async function begin(harness: Harness, returnTo?: string) {
  const { flowId, authorizeUrl } = await harness.signIn.start(returnTo);
  const url = new URL(authorizeUrl);
  return { flowId, url, state: url.searchParams.get('state')! };
}

const formBody = (body: unknown) =>
  typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : (body as Record<string, string>);

/** The portal answering a code exchange and a userinfo read. Records what it was sent. */
function portalAnswers(claims: Record<string, unknown>) {
  const sent: { token?: Record<string, string>; tokenAuthorization?: string } = {};
  const token = nock(ISSUER)
    .post('/oauth/token', (body) => {
      sent.token = formBody(body);
      return true;
    })
    .reply(function reply() {
      sent.tokenAuthorization = this.req.headers.authorization as string | undefined;
      return [200, { access_token: 'portal-access', refresh_token: 'portal-refresh-1', token_type: 'Bearer', expires_in: 600 }];
    });
  const userinfo = nock(ISSUER)
    .get('/oauth/userinfo')
    .matchHeader('authorization', 'Bearer portal-access')
    .reply(200, claims);
  return { sent, token, userinfo };
}

const person = (overrides: Record<string, unknown> = {}) => ({
  sub: SUBJECT,
  email: 'avery.office@texasrenters.com',
  email_verified: true,
  name: 'Avery Office',
  department: 'Leasing',
  apps: [APP_SLUG, 'another-app'],
  ...overrides,
});

const refusal = (reason: string) => ({ code: 'PORTAL_SIGN_IN_REFUSED', details: [{ reason }] });

const claimsOf = (accessToken: string) =>
  JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('starting a portal sign-in', () => {
  usePortalEnvironment();

  it('sends the browser to the portal with a PKCE S256 challenge and the fixed scope', async () => {
    const harness = build([]);
    const { flowId, url, state } = await begin(harness);

    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://inspection.texasrenters.com/auth/portal/callback',
      scope: 'openid profile email apps',
      state,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    });
    // The secret never goes to the browser.
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    // State and verifier are kept server-side, and the challenge is the verifier's.
    const flow = harness.store.flows.get(flowId)!;
    expect(flow.state).toBe(state);
    expect(createHash('sha256').update(flow.verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
  });

  it('remembers where the person was going, but only a path on the console', async () => {
    const harness = build([]);
    const { flowId } = await begin(harness, '/inspections/42?tab=photos');
    expect(harness.store.flows.get(flowId)!.returnTo).toBe('/inspections/42?tab=photos');

    for (const elsewhere of [
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/\t/evil.example',
      '/login',
      '/auth/portal/redirect',
    ])
      expect(safeReturnTo(elsewhere)).toBe('/dashboard');
  });

  it('refuses to start while the session store is unreachable', async () => {
    const harness = build([]);
    harness.store.unavailable = true;
    await expect(harness.signIn.start()).rejects.toMatchObject(refusal('unavailable'));
  });
});

describe('the portal sending the person back', () => {
  usePortalEnvironment();

  it('refuses a wrong state without sending any token request', async () => {
    const harness = build([staffAccount()]);
    const { flowId } = await begin(harness);
    const portal = portalAnswers(person());

    await expect(
      harness.signIn.complete({ flowId, state: 'not-the-state', code: 'code-1' }, {}),
    ).rejects.toMatchObject(refusal('expired'));
    expect(portal.token.isDone()).toBe(false);
  });

  it('refuses a missing state without sending any token request', async () => {
    const harness = build([staffAccount()]);
    const { flowId } = await begin(harness);
    const portal = portalAnswers(person());

    await expect(harness.signIn.complete({ flowId, code: 'code-1' }, {})).rejects.toMatchObject(refusal('expired'));
    expect(portal.token.isDone()).toBe(false);
  });

  it('uses a sign-in once: a wrong state spends it, so the right one afterwards is refused', async () => {
    const harness = build([staffAccount()]);
    const { flowId, state } = await begin(harness);
    const portal = portalAnswers(person());

    await expect(harness.signIn.complete({ flowId, state: 'guess', code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('expired'),
    );
    await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('expired'),
    );
    expect(portal.token.isDone()).toBe(false);
  });

  it('refuses a replayed callback, with no second token request', async () => {
    const harness = build([staffAccount()]);
    const { flowId, state } = await begin(harness);
    portalAnswers(person());

    await harness.signIn.complete({ flowId, state, code: 'code-1' }, {});
    const second = nock(ISSUER).post('/oauth/token').reply(200, {});
    await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('expired'),
    );
    expect(second.isDone()).toBe(false);
  });

  it('refuses when the portal returned an error or no code, without a token request', async () => {
    const harness = build([staffAccount()]);
    const portal = portalAnswers(person());

    const denied = await begin(harness);
    await expect(
      harness.signIn.complete({ flowId: denied.flowId, state: denied.state, error: 'access_denied' }, {}),
    ).rejects.toMatchObject(refusal('denied'));
    const empty = await begin(harness);
    await expect(harness.signIn.complete({ flowId: empty.flowId, state: empty.state }, {})).rejects.toMatchObject(
      refusal('denied'),
    );
    expect(portal.token.isDone()).toBe(false);
  });

  it('exchanges the code with the verifier, sending the client credentials in the form body', async () => {
    const harness = build([staffAccount({ portalSubject: SUBJECT })]);
    const { flowId, state, url } = await begin(harness);
    const portal = portalAnswers(person());

    await harness.signIn.complete({ flowId, state, code: 'code-1' }, {});

    expect(portal.sent.token).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://inspection.texasrenters.com/auth/portal/callback',
      code_verifier: expect.any(String),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(createHash('sha256').update(portal.sent.token!.code_verifier!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    // client_secret_post: nothing in a header.
    expect(portal.sent.tokenAuthorization).toBeUndefined();
    expect(portal.userinfo.isDone()).toBe(true);
  });

  it('refuses someone whose apps do not include this app, and issues nothing', async () => {
    const harness = build([staffAccount({ portalSubject: SUBJECT })]);
    for (const apps of [['another-app'], undefined, 'inspection']) {
      const { flowId, state } = await begin(harness);
      portalAnswers(person({ apps }));
      await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
        refusal('no_access'),
      );
    }
    expect(harness.db.refreshTokens).toEqual([]);
    expect(harness.store.sessions.size).toBe(0);
  });

  it('issues a console session that names its portal session, and keeps the portal token sealed', async () => {
    const account = staffAccount({ portalSubject: SUBJECT });
    const harness = build([account]);
    const { flowId, state } = await begin(harness, '/inspections/42');
    portalAnswers(person());

    const session = await harness.signIn.complete({ flowId, state, code: 'code-1' }, {});

    expect(session.returnTo).toBe('/inspections/42');
    expect(session.mustChangePassword).toBe(false);
    const portalSessionId = harness.tokens.portalSessionIdOf(session.refreshToken);
    expect(portalSessionId).toEqual(expect.any(String));
    const claims = claimsOf(session.accessToken);
    expect(claims.psid).toBe(portalSessionId);
    expect(claims.sub).toBe(account.authUserId);
    // Lives until the next check is due, PORTAL_RECHECK_MINUTES.
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);

    const record = harness.store.sessions.get(portalSessionId!)!;
    expect(record).toMatchObject({ authUserId: account.authUserId, subject: SUBJECT });
    expect(record.refreshToken).not.toContain('portal-refresh-1');
    expect(openSecret(record.refreshToken, portalTokenKey(readPortalConfig().settings!))).toBe('portal-refresh-1');

    // Stored only as a hash, as a console session, for no longer than a portal sign-in.
    const row = harness.db.refreshTokens[0]!;
    expect(row.tokenHash).toBe(harness.tokens.hashRefreshToken(session.refreshToken));
    expect(row.fromConsole).toBe(true);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
  });

  it('refuses while the session store is unreachable, and issues nothing', async () => {
    const harness = build([staffAccount({ portalSubject: SUBJECT })]);
    const { flowId, state } = await begin(harness);
    harness.store.unavailable = true;
    await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('unavailable'),
    );
    expect(harness.db.refreshTokens).toEqual([]);
  });

  it('treats a portal outage during the exchange as unavailable, not as a refusal of the person', async () => {
    const harness = build([staffAccount({ portalSubject: SUBJECT })]);
    const { flowId, state } = await begin(harness);
    nock(ISSUER).post('/oauth/token').reply(503);
    await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('unavailable'),
    );
  });
});

describe('linking the person to an account here', () => {
  usePortalEnvironment();

  async function signInAs(accounts: AccountRow[], claims: Record<string, unknown>) {
    const harness = build(accounts);
    const { flowId, state } = await begin(harness);
    portalAnswers(claims);
    const result = harness.signIn.complete({ flowId, state, code: 'code-1' }, {});
    return { harness, result };
  }

  it('finds someone who signed in before by sub, whatever their address now says', async () => {
    const account = staffAccount({ portalSubject: SUBJECT });
    const { harness, result } = await signInAs([account], person({ email: 'renamed@gmail.com', email_verified: false }));
    await expect(result).resolves.toMatchObject({ refreshToken: expect.stringMatching(/^p\./) });
    expect(harness.db.profileWrites).toEqual([]);
  });

  it('refuses a linked account that is no longer staff, or no longer active', async () => {
    const technician = staffAccount({
      portalSubject: SUBJECT,
      memberships: [{ organizationId: ORG, role: UserRole.INSPECTION_TECHNICIAN }],
      roleAssignments: [],
    });
    await expect((await signInAs([technician], person())).result).rejects.toMatchObject(refusal('no_account'));
    const inactive = staffAccount({ portalSubject: SUBJECT, isActive: false });
    await expect((await signInAs([inactive], person())).result).rejects.toMatchObject(refusal('no_account'));
  });

  it('links a first sign-in by a verified company address, writing only the portal subject', async () => {
    const account = staffAccount({ email: 'avery.office@texasrenters.com' });
    const memberships = structuredClone(account.memberships);
    const roleAssignments = structuredClone(account.roleAssignments);
    const { harness, result } = await signInAs([account], person({ email: 'Avery.Office@TexasRenters.com' }));

    await expect(result).resolves.toMatchObject({ refreshToken: expect.stringMatching(/^p\./) });
    expect(account.portalSubject).toBe(SUBJECT);
    expect(harness.db.profileWrites).toEqual([
      { where: { id: account.id, portalSubject: null }, data: { portalSubject: SUBJECT } },
    ]);
    // Roles, permissions and the profile are exactly as they were.
    expect(account.memberships).toEqual(memberships);
    expect(account.roleAssignments).toEqual(roleAssignments);
    expect(account.email).toBe('avery.office@texasrenters.com');
    expect(harness.db.auditRows).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        action: 'auth.portal.account_linked',
        entityType: 'UserProfile',
        entityId: account.id,
      }),
    ]);
  });

  it('links an address at the second company domain too', async () => {
    const account = staffAccount({ email: 'sam@texra.net' });
    const { result } = await signInAs([account], person({ email: 'sam@texra.net' }));
    await expect(result).resolves.toBeDefined();
    expect(account.portalSubject).toBe(SUBJECT);
  });

  it('refuses an address the portal has not verified', async () => {
    const account = staffAccount();
    for (const verified of [false, 'true', undefined]) {
      const { harness, result } = await signInAs([account], person({ email_verified: verified }));
      await expect(result).rejects.toMatchObject(refusal('no_account'));
      expect(harness.db.profileWrites).toEqual([]);
    }
  });

  it('refuses an address outside the company domains, including lookalike domains', async () => {
    for (const email of [
      'avery.office@gmail.com',
      'avery.office@texasrenters.com.evil.example',
      'avery.office@mail.texasrenters.com',
      'avery.office',
    ]) {
      const account = staffAccount({ email });
      const { harness, result } = await signInAs([account], person({ email }));
      await expect(result).rejects.toMatchObject(refusal('no_account'));
      expect(harness.db.profileWrites).toEqual([]);
    }
  });

  it('refuses someone with no account, and creates nothing', async () => {
    const { harness, result } = await signInAs([], person());
    await expect(result).rejects.toMatchObject(refusal('no_account'));
    expect(harness.db.profileWrites).toEqual([]);
    expect(harness.db.refreshTokens).toEqual([]);
    expect(harness.store.sessions.size).toBe(0);
    expect('create' in harness.db.prisma.userProfile).toBe(false);
  });

  it('refuses when more than one account has the address', async () => {
    const { harness, result } = await signInAs(
      [staffAccount({ email: 'avery.office@texasrenters.com' }), staffAccount({ email: 'Avery.Office@texasrenters.com' })],
      person(),
    );
    await expect(result).rejects.toMatchObject(refusal('no_account'));
    expect(harness.db.profileWrites).toEqual([]);
  });

  it('refuses a match the database made that is not the same address', async () => {
    // A collation or a LIKE wildcard can call these equal; they are not.
    const lookalike = staffAccount({ email: 'averyxoffice@texasrenters.com' });
    const harness = build([lookalike]);
    harness.db.prisma.userProfile.findMany.mockResolvedValueOnce([lookalike]);
    const { flowId, state } = await begin(harness);
    portalAnswers(person({ email: 'avery_office@texasrenters.com' }));
    await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('no_account'),
    );
    expect(lookalike.portalSubject).toBeNull();
  });

  it('refuses an account already linked to a different portal identity, and leaves the link alone', async () => {
    const account = staffAccount({ portalSubject: 'someone-else-entirely' });
    const { harness, result } = await signInAs([account], person());
    await expect(result).rejects.toMatchObject(refusal('no_account'));
    expect(account.portalSubject).toBe('someone-else-entirely');
    expect(harness.db.profileWrites).toEqual([]);
    expect(harness.db.auditRows).toEqual([
      expect.objectContaining({ action: 'auth.portal.sign_in_refused', entityId: account.id }),
    ]);
  });

  it('refuses an account that is not staff: a technician, or a property owner', async () => {
    for (const role of [UserRole.INSPECTION_TECHNICIAN, UserRole.PROPERTY_OWNER_READ_ONLY]) {
      const account = staffAccount({ memberships: [{ organizationId: ORG, role }], roleAssignments: [] });
      const { harness, result } = await signInAs([account], person());
      await expect(result).rejects.toMatchObject(refusal('no_account'));
      expect(harness.db.profileWrites).toEqual([]);
    }
  });

  it('refuses a deactivated account', async () => {
    const { result } = await signInAs([staffAccount({ isActive: false })], person());
    await expect(result).rejects.toMatchObject(refusal('no_account'));
  });

  it('refuses when another sign-in linked the account first', async () => {
    const account = staffAccount();
    const harness = build([account]);
    harness.db.prisma.userProfile.updateMany.mockResolvedValueOnce({ count: 0 });
    const { flowId, state } = await begin(harness);
    portalAnswers(person());
    await expect(harness.signIn.complete({ flowId, state, code: 'code-1' }, {})).rejects.toMatchObject(
      refusal('no_account'),
    );
    expect(harness.db.refreshTokens).toEqual([]);
  });
});
