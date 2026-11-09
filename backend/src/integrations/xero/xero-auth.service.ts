import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../common/prisma.service';
import { openSecret, readEnvelopeKey, sealSecret } from '../../common/secret-envelope';
import { getXeroConfig, xeroConfigured } from './xero.config';
import { XeroError } from './xero.errors';

/** An authorization code lives minutes; the sign-in it began is refused after ten. */
const STATE_TTL_MS = 10 * 60_000;
/** Refresh a minute early rather than spend a request on a token about to die. */
const EXPIRY_SKEW_MS = 60_000;

export interface XeroAuthState {
  organizationId: string;
  userId: string | null;
  codeVerifier: string;
  issuedAt: number;
  nonce: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/**
 * The office's Xero sign-in and its tokens (2026-11-10, phase 1 of the Xero
 * plan), as the Jobber connection keeps its own:
 *
 * - the callback is a browser redirect with no session, so everything needed
 *   to finish it rides in a `state` sealed with a server-side key -- the
 *   organization, the PKCE verifier and when it began;
 * - tokens are stored only as envelopes under `XERO_TOKEN_ENCRYPTION_KEY`, a
 *   key of Xero's own, and only this service writes them;
 * - Xero rotates the refresh token on every use, so two refreshes at once
 *   would spend one token twice and kill the connection at the next: they are
 *   collapsed onto one request.
 */
@Injectable()
export class XeroAuthService {
  private readonly logger = new Logger(XeroAuthService.name);
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private config() {
    return getXeroConfig();
  }

  private key() {
    const key = readEnvelopeKey(process.env.XERO_TOKEN_ENCRYPTION_KEY, 'XERO_TOKEN_ENCRYPTION_KEY');
    if (!key) throw new XeroError('Secure Xero token storage is not set up on this server.', 'XERO_TOKEN_STORAGE_NOT_CONFIGURED', 503);
    return key;
  }

  /** Where somebody who runs the integrations signs in to Xero and picks the organisation. */
  authorizationUrl(input: { organizationId: string; userId: string | null }) {
    const config = this.config();
    if (!xeroConfigured(config)) throw new XeroError('Xero is not set up on this server.', 'XERO_NOT_CONFIGURED', 503);
    const codeVerifier = randomBytes(32).toString('base64url');
    const state: XeroAuthState = {
      organizationId: input.organizationId,
      userId: input.userId,
      codeVerifier,
      issuedAt: Date.now(),
      nonce: randomBytes(16).toString('base64url'),
    };
    const url = new URL(config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId!);
    url.searchParams.set('redirect_uri', config.redirectUri!);
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', sealSecret(JSON.stringify(state), this.key()));
    url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** The sign-in behind a callback; refused when it cannot be opened, or is old. */
  readState(raw: string | undefined): XeroAuthState {
    const invalid = () => new XeroError('The Xero sign-in could not be checked. Start it again.', 'XERO_STATE_INVALID', 400);
    if (!raw) throw invalid();
    const opened = openSecret(raw, this.key());
    if (!opened) throw invalid();
    let state: XeroAuthState;
    try {
      state = JSON.parse(opened) as XeroAuthState;
    } catch {
      throw invalid();
    }
    if (typeof state.organizationId !== 'string' || typeof state.codeVerifier !== 'string' || typeof state.issuedAt !== 'number') throw invalid();
    if (Date.now() - state.issuedAt > STATE_TTL_MS)
      throw new XeroError('The Xero sign-in took too long. Start it again.', 'XERO_STATE_EXPIRED', 400);
    return state;
  }

  /** The first tokens, for the code Xero sent back. Not stored: the caller checks the organisation first. */
  async exchange(code: string, codeVerifier: string): Promise<TokenResponse> {
    const payload = await this.postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config().redirectUri ?? '',
      code_verifier: codeVerifier,
    });
    if (!payload.refresh_token)
      throw new XeroError('Xero gave no refresh token. Connect again, allowing offline access.', 'XERO_NO_REFRESH_TOKEN', 502);
    return payload;
  }

  /** Seals and keeps a token pair; the only writer of the credential columns. */
  async store(organizationId: string, payload: TokenResponse, extra: Record<string, unknown> = {}) {
    const key = this.key();
    const credentials = {
      accessTokenCiphertext: sealSecret(payload.access_token, key),
      accessTokenExpiresAt: new Date(Date.now() + payload.expires_in * 1_000),
      ...(payload.refresh_token ? { refreshTokenCiphertext: sealSecret(payload.refresh_token, key) } : {}),
      ...(payload.scope ? { scopes: payload.scope.split(' ').filter(Boolean) } : {}),
      status: 'CONNECTED',
      lastRefreshedAt: new Date(),
      lastRefreshError: null,
      ...extra,
    };
    await this.prisma.xeroConnection.upsert({
      where: { organizationId },
      create: { organizationId, ...credentials },
      update: credentials,
    });
  }

  /** A bearer token good now, refreshing first when it is about to expire. */
  async accessToken(organizationId: string): Promise<string> {
    const connection = await this.prisma.xeroConnection.findUnique({
      where: { organizationId },
      select: { status: true, accessTokenCiphertext: true, accessTokenExpiresAt: true },
    });
    if (!connection || connection.status !== 'CONNECTED')
      throw new XeroError('Xero is not connected.', 'XERO_NOT_CONNECTED', 409);
    const fresh = connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
    if (fresh && connection.accessTokenCiphertext) {
      const token = openSecret(connection.accessTokenCiphertext, this.key());
      if (token) return token;
      await this.requireReconnect(organizationId, 'The stored Xero tokens could not be read: the key changed.');
      throw new XeroError('Xero must be connected again.', 'XERO_REAUTHORIZATION_REQUIRED', 409);
    }
    return this.refresh(organizationId);
  }

  refresh(organizationId: string): Promise<string> {
    const running = this.inFlight.get(organizationId);
    if (running) return running;
    const attempt = this.performRefresh(organizationId).finally(() => this.inFlight.delete(organizationId));
    this.inFlight.set(organizationId, attempt);
    return attempt;
  }

  private async performRefresh(organizationId: string) {
    const connection = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { refreshTokenCiphertext: true } });
    if (!connection?.refreshTokenCiphertext) throw new XeroError('Xero is not connected.', 'XERO_NOT_CONNECTED', 409);
    const refreshToken = openSecret(connection.refreshTokenCiphertext, this.key());
    if (!refreshToken) {
      await this.requireReconnect(organizationId, 'The stored Xero tokens could not be read: the key changed.');
      throw new XeroError('Xero must be connected again.', 'XERO_REAUTHORIZATION_REQUIRED', 409);
    }
    let payload: TokenResponse;
    try {
      payload = await this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch (error) {
      // Xero refused the refresh token -- revoked, or unused for 60 days: only a new sign-in mends it.
      // Anything else (a timeout, a 500) leaves it connected, to try again.
      if (error instanceof XeroError && (error.providerStatus === 400 || error.providerStatus === 401))
        await this.requireReconnect(organizationId, 'Xero refused the stored sign-in. Connect again.');
      throw error;
    }
    await this.store(organizationId, payload);
    return payload.access_token;
  }

  /** Gives Xero its refresh token back, so the grant ends there too. Best effort. */
  async revoke(organizationId: string) {
    const connection = await this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { refreshTokenCiphertext: true } });
    const token = connection?.refreshTokenCiphertext ? openSecret(connection.refreshTokenCiphertext, this.key()) : null;
    if (!token) return false;
    try {
      const response = await fetch(this.config().revocationUrl, {
        method: 'POST',
        headers: { authorization: this.basic(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(this.config().requestTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async requireReconnect(organizationId: string, reason: string) {
    await this.prisma.xeroConnection.updateMany({
      where: { organizationId },
      data: { status: 'REAUTHORIZATION_REQUIRED', lastRefreshError: reason, accessTokenCiphertext: null, accessTokenExpiresAt: null },
    });
    this.logger.warn({ event: 'xero_reconnect_required', organizationId });
  }

  private basic() {
    const config = this.config();
    return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }

  private async postToken(body: Record<string, string>): Promise<TokenResponse> {
    const config = this.config();
    if (!xeroConfigured(config)) throw new XeroError('Xero is not set up on this server.', 'XERO_NOT_CONFIGURED', 503);
    let response: Response;
    try {
      response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { authorization: this.basic(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch {
      throw new XeroError('Xero could not be reached. Try again in a moment.', 'XERO_UNREACHABLE', 502);
    }
    if (!response.ok)
      throw new XeroError(
        response.status === 400 || response.status === 401 ? 'Xero refused the sign-in.' : 'Xero did not answer as expected.',
        'XERO_TOKEN_REFUSED',
        502,
        response.status,
      );
    const payload = (await response.json().catch(() => null)) as TokenResponse | null;
    if (!payload?.access_token || typeof payload.expires_in !== 'number')
      throw new XeroError('Xero did not answer as expected.', 'XERO_TOKEN_REFUSED', 502, response.status);
    return payload;
  }
}

/** The sign-in a token came from: Xero puts it in the access token, which says which organisations it chose. */
export function authEventOf(accessToken: string): string | null {
  const [, body] = accessToken.split('.');
  if (!body) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { authentication_event_id?: unknown };
    return typeof claims.authentication_event_id === 'string' ? claims.authentication_event_id : null;
  } catch {
    return null;
  }
}
