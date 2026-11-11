import { randomUUID } from 'node:crypto';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type KeyObject } from 'jose';
import * as nock from 'nock';

import { AuthController } from '../src/auth/auth.controller';
import { PasswordResetService } from '../src/auth/password-reset.service';
import { PortalClient } from '../src/auth/portal/portal.client';
import { PortalController, PortalLogoutGuard } from '../src/auth/portal/portal.controller';
import { BACKCHANNEL_LOGOUT_EVENT, PortalLogoutTokenVerifier } from '../src/auth/portal/portal-logout-token';
import { PortalLogoutService } from '../src/auth/portal/portal-logout.service';
import { PortalSessionService } from '../src/auth/portal/portal-session.service';
import { PortalSignInService } from '../src/auth/portal/portal-sign-in.service';
import { PortalStore } from '../src/auth/portal/portal.store';
import { SessionService } from '../src/auth/session.service';
import { TokenService } from '../src/auth/token.service';
import { ApplicationExceptionFilter } from '../src/common/errors';
import { PrismaService } from '../src/common/prisma.service';
import {
  CLIENT_ID,
  ISSUER,
  MemoryPortalStore,
  fakeDatabase,
  staffAccount,
  usePortalEnvironment,
  type AccountRow,
} from './support/portal';

/**
 * The portal's back-channel logout, over HTTP, against a key generated here
 * and served as the portal's JWKS.
 */

type SigningKey = CryptoKey | KeyObject | Uint8Array;

const KID = 'portal-key-1';
let portalKey: { privateKey: SigningKey; jwk: Record<string, unknown> };
let strangerKey: SigningKey;

beforeAll(async () => {
  nock.disableNetConnect();
  // The app under test listens on loopback; everything else is the mocked portal.
  nock.enableNetConnect('127.0.0.1');
  const pair = await generateKeyPair('RS256', { extractable: true });
  portalKey = { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' } };
  strangerKey = (await generateKeyPair('RS256')).privateKey;
});
afterAll(() => nock.enableNetConnect());

const nowSeconds = () => Math.floor(Date.now() / 1000);

function logoutClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'portal-sub-avery',
    iat: nowSeconds(),
    exp: nowSeconds() + 120,
    jti: randomUUID(),
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...overrides,
  };
}

async function logoutToken(
  claims: Record<string, unknown> = logoutClaims(),
  options: { key?: SigningKey; kid?: string | null; typ?: string; alg?: string } = {},
) {
  const header: Record<string, unknown> = { alg: options.alg ?? 'RS256', typ: options.typ ?? 'logout+jwt' };
  if (options.kid !== null) header.kid = options.kid ?? KID;
  return new SignJWT(claims).setProtectedHeader(header as never).sign(options.key ?? portalKey.privateKey);
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function boot(accounts: AccountRow[]) {
  const db = fakeDatabase(accounts);
  const store = new MemoryPortalStore();
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController, PortalController],
    providers: [
      { provide: PrismaService, useValue: db.prisma },
      { provide: PortalStore, useValue: store },
      { provide: PasswordResetService, useValue: {} },
      PortalClient,
      PortalLogoutTokenVerifier,
      PortalSessionService,
      PortalSignInService,
      PortalLogoutService,
      PortalLogoutGuard,
      SessionService,
      TokenService,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // What main.ts's configureApplication sets that these routes depend on.
  // Importing main.ts would load AppModule and validate the whole environment.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ApplicationExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;
  return { app, db, store, base, tokens: moduleRef.get(TokenService), portal: moduleRef.get(PortalSessionService) };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** Two people, each signed in to the console through the portal, one also on the phone with a password. */
async function twoPeopleSignedIn(booted: Booted, avery: AccountRow, blake: AccountRow) {
  const sessions = new Map<string, { portalSessionId: string }>();
  for (const account of [avery, blake]) {
    const portalSessionId = booted.tokens.newPortalSessionId();
    await booted.portal.begin(portalSessionId, {
      authUserId: account.authUserId,
      subject: account.portalSubject!,
      refreshToken: `portal-refresh-${account.authUserId}`,
    });
    const refresh = booted.tokens.createRefreshToken({ portalSessionId });
    await booted.db.prisma.authRefreshToken.create({
      data: { authUserId: account.authUserId, tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt, deviceId: null, fromConsole: true },
    });
    sessions.set(account.authUserId, { portalSessionId });
  }
  // A remembered console password sign-in and a phone for Avery.
  for (const fromConsole of [true, false]) {
    const refresh = booted.tokens.createRefreshToken();
    await booted.db.prisma.authRefreshToken.create({
      data: { authUserId: avery.authUserId, tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt, deviceId: fromConsole ? null : 'phone-1', fromConsole },
    });
  }
  return sessions;
}

const post = (base: string, body: Record<string, string>) =>
  fetch(`${base}/auth/portal/backchannel-logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

describe('the back-channel logout', () => {
  usePortalEnvironment();

  let booted: Booted;
  let avery: AccountRow;
  let blake: AccountRow;

  beforeEach(async () => {
    nock(ISSUER).get('/oauth/jwks').reply(200, { keys: [portalKey.jwk] }).persist();
    avery = staffAccount({ portalSubject: 'portal-sub-avery', email: 'avery@texasrenters.com' });
    blake = staffAccount({ portalSubject: 'portal-sub-blake', email: 'blake@texasrenters.com' });
    booted = await boot([avery, blake]);
    await twoPeopleSignedIn(booted, avery, blake);
  });

  afterEach(async () => {
    await booted.app.close();
    nock.cleanAll();
  });

  const nothingChanged = () => {
    expect(booted.db.refreshTokens.every((row) => row.revokedAt === null)).toBe(true);
    expect(booted.store.sessions.size).toBe(2);
  };

  it('ends every console session of that person, and only theirs', async () => {
    const response = await post(booted.base, { logout_token: await logoutToken() });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const rows = (authUserId: string, fromConsole: boolean) =>
      booted.db.refreshTokens.filter((row) => row.authUserId === authUserId && row.fromConsole === fromConsole);
    // Portal sign-in and remembered password sign-in alike.
    expect(rows(avery.authUserId, true).map((row) => row.revokedAt)).toEqual([expect.any(Date), expect.any(Date)]);
    // The phone is a password sign-in the portal knows nothing about.
    expect(rows(avery.authUserId, false).map((row) => row.revokedAt)).toEqual([null]);
    expect(rows(blake.authUserId, true).map((row) => row.revokedAt)).toEqual([null]);
    expect([...booted.store.sessions.values()].map((record) => record.authUserId)).toEqual([blake.authUserId]);
    expect(booted.db.auditRows).toEqual([
      expect.objectContaining({ action: 'auth.portal.backchannel_logout', entityId: avery.id }),
    ]);
  });

  it('answers 200 for someone with no account here, and changes nothing', async () => {
    const response = await post(booted.base, { logout_token: await logoutToken(logoutClaims({ sub: 'nobody-here' })) });
    expect(response.status).toBe(200);
    nothingChanged();
  });

  it.each<[string, () => Promise<string>]>([
    ['a bad signature', () => logoutToken(logoutClaims(), { key: strangerKey })],
    ['the wrong issuer', () => logoutToken(logoutClaims({ iss: `${ISSUER}/` }))],
    ['another issuer altogether', () => logoutToken(logoutClaims({ iss: 'https://login.example.com' }))],
    ['the wrong audience', () => logoutToken(logoutClaims({ aud: 'some-other-app' }))],
    ['no events', () => logoutToken(logoutClaims({ events: undefined }))],
    ['the wrong event', () => logoutToken(logoutClaims({ events: { 'http://example.com/other': {} } }))],
    ['a nonce', () => logoutToken(logoutClaims({ nonce: 'n-0S6_WzA2Mj' }))],
    // Ten minutes, plus the sixty seconds allowed for clock skew.
    ['an old iat', () => logoutToken(logoutClaims({ iat: nowSeconds() - 12 * 60, exp: nowSeconds() + 120 }))],
    ['an iat in the future', () => logoutToken(logoutClaims({ iat: nowSeconds() + 5 * 60 }))],
    ['an exp that has passed', () => logoutToken(logoutClaims({ iat: nowSeconds() - 300, exp: nowSeconds() - 180 }))],
    ['an empty sub', () => logoutToken(logoutClaims({ sub: '' }))],
    ['no jti', () => logoutToken(logoutClaims({ jti: undefined }))],
    ['the wrong typ', () => logoutToken(logoutClaims(), { typ: 'JWT' })],
    ['no kid', () => logoutToken(logoutClaims(), { kid: null })],
    ['an unknown kid', () => logoutToken(logoutClaims(), { kid: 'some-other-key' })],
    ['alg none', async () => `${encode({ alg: 'none', kid: KID, typ: 'logout+jwt' })}.${encode(logoutClaims())}.`],
    [
      'HS256',
      () =>
        logoutToken(logoutClaims(), {
          alg: 'HS256',
          key: new TextEncoder().encode('a-guessable-shared-secret-of-enough-length'),
        }),
    ],
    ['garbage', async () => 'not.a.token'],
  ])('refuses a token with %s: 400, and nothing changes', async (_label, make) => {
    const response = await post(booted.base, { logout_token: await make() });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    nothingChanged();
  });

  it('refuses a request with no token, or with fields it does not know', async () => {
    expect((await post(booted.base, {})).status).toBe(400);
    expect((await post(booted.base, { logout_token: await logoutToken(), extra: 'x' })).status).toBe(400);
    nothingChanged();
  });

  it('rate-limits at 120 requests a minute', async () => {
    const burst = async () => {
      booted.store.counts.clear();
      const minute = Math.floor(Date.now() / 60_000);
      const statuses: number[] = [];
      for (let index = 0; index < 121; index += 1)
        statuses.push((await post(booted.base, { logout_token: 'not.a.token' })).status);
      return { statuses, sameMinute: minute === Math.floor(Date.now() / 60_000) };
    };
    // A burst that straddles the minute is counted in two windows; run it again.
    let { statuses, sameMinute } = await burst();
    if (!sameMinute) ({ statuses, sameMinute } = await burst());
    expect(statuses.slice(0, 120).every((status) => status === 400)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe('the key set', () => {
  usePortalEnvironment();

  it('is fetched once and reused, and a failed fetch is not cached', async () => {
    const account = staffAccount({ portalSubject: 'portal-sub-avery' });
    const booted = await boot([account]);
    try {
      nock(ISSUER).get('/oauth/jwks').reply(503);
      expect((await post(booted.base, { logout_token: await logoutToken() })).status).toBe(400);

      const keys = nock(ISSUER).get('/oauth/jwks').reply(200, { keys: [portalKey.jwk] });
      expect((await post(booted.base, { logout_token: await logoutToken() })).status).toBe(200);
      expect(keys.isDone()).toBe(true);

      // Cached: no further fetch for a known kid.
      const again = nock(ISSUER).get('/oauth/jwks').reply(200, { keys: [portalKey.jwk] });
      expect((await post(booted.base, { logout_token: await logoutToken() })).status).toBe(200);
      expect(again.isDone()).toBe(false);
      // And an unknown kid inside the 30-second cooldown does not refetch either.
      expect((await post(booted.base, { logout_token: await logoutToken(logoutClaims(), { kid: 'rotated-key' }) })).status).toBe(400);
      expect(again.isDone()).toBe(false);
    } finally {
      await booted.app.close();
      nock.cleanAll();
    }
  });
});

describe('signing out of the console', () => {
  usePortalEnvironment();

  it('sends someone who signed in through the portal to its dashboard, and everyone else nowhere new', async () => {
    const account = staffAccount({ portalSubject: 'portal-sub-avery' });
    const booted = await boot([account]);
    try {
      const portalSessionId = booted.tokens.newPortalSessionId();
      const portalRefresh = booted.tokens.createRefreshToken({ portalSessionId });
      const passwordRefresh = booted.tokens.createRefreshToken();
      for (const token of [portalRefresh, passwordRefresh])
        await booted.db.prisma.authRefreshToken.create({
          data: { authUserId: account.authUserId, tokenHash: token.tokenHash, expiresAt: token.expiresAt, deviceId: null, fromConsole: true },
        });
      const signOut = (refreshToken: string) =>
        fetch(`${booted.base}/auth/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

      const portal = await signOut(portalRefresh.token);
      expect(portal.status).toBe(200);
      expect(await portal.json()).toEqual({ signedOutUrl: 'https://login.texasrenters.com/dashboard' });

      const password = await signOut(passwordRefresh.token);
      expect(password.status).toBe(204);
      expect(await password.text()).toBe('');
    } finally {
      await booted.app.close();
    }
  });
});

describe('with PORTAL_ENABLED=false', () => {
  usePortalEnvironment({ PORTAL_ENABLED: 'false' });

  it('offers no portal, answers none of its routes, and changes nothing', async () => {
    const account = staffAccount({ portalSubject: 'portal-sub-avery' });
    const booted = await boot([account]);
    const jwks = nock(ISSUER).get('/oauth/jwks').reply(200, { keys: [portalKey.jwk] });
    try {
      expect(await (await fetch(`${booted.base}/auth/portal`)).json()).toEqual({ enabled: false });
      const start = await fetch(`${booted.base}/auth/portal/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(start.status).toBe(404);
      const complete = await fetch(`${booted.base}/auth/portal/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowId: 'a'.repeat(43), state: 's', code: 'c' }),
      });
      expect(complete.status).toBe(404);
      expect((await post(booted.base, { logout_token: await logoutToken() })).status).toBe(404);
      expect(jwks.isDone()).toBe(false);
      expect(booted.db.prisma.authRefreshToken.updateMany).not.toHaveBeenCalled();

      // Password sign-out is the 204 it always was.
      const signOut = await fetch(`${booted.base}/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: booted.tokens.createRefreshToken().token }),
      });
      expect(signOut.status).toBe(204);
    } finally {
      await booted.app.close();
      nock.cleanAll();
    }
  });
});
