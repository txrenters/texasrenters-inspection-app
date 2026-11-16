import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { openSecret, readEnvelopeKey, sealSecret } from '../../common/secret-envelope';
import { getMicrosoftConfig, loginBase, microsoftConfigured } from './microsoft.config';

/**
 * The office's Microsoft account for the Actual vs Budget workbook
 * (2026-11-17), as the Xero connection keeps Xero's: the sign-in carries a
 * sealed, ten-minute state and PKCE; the tokens are sealed at rest with
 * MICROSOFT_TOKEN_ENCRYPTION_KEY and never leave the server; the access token
 * is renewed a minute before it lapses, one renewal at a time, and a refusal
 * asks for the account to be connected again rather than trying for ever.
 */

const STATE_TTL_MS = 10 * 60_000;
const EXPIRY_SKEW_MS = 60_000;

export interface MicrosoftAuthState {
  organizationId: string;
  userId: string | null;
  codeVerifier: string;
  issuedAt: number;
  nonce: string;
}

export interface MicrosoftTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export class MicrosoftError extends ApplicationError {
  constructor(
    message: string,
    code: string,
    status: number,
    readonly providerStatus?: number,
  ) {
    super(status, code, message);
  }
}

@Injectable()
export class MicrosoftAuthService {
  private readonly logger = new Logger(MicrosoftAuthService.name);
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  config() {
    return getMicrosoftConfig();
  }

  private key() {
    const key = readEnvelopeKey(process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY, 'MICROSOFT_TOKEN_ENCRYPTION_KEY');
    if (!key) throw new MicrosoftError('Secure Microsoft sign-in storage is not set up on this server.', 'MICROSOFT_TOKEN_STORAGE_NOT_CONFIGURED', 503);
    return key;
  }

  /** Where to send the person to sign in: Microsoft's own page, with a sealed state and PKCE. */
  authorizationUrl(input: { organizationId: string; userId: string | null }) {
    const config = this.config();
    if (!microsoftConfigured(config)) throw new MicrosoftError('Microsoft sign-in is not set up on this server.', 'MICROSOFT_NOT_CONFIGURED', 503);
    const codeVerifier = randomBytes(32).toString('base64url');
    const state: MicrosoftAuthState = {
      organizationId: input.organizationId,
      userId: input.userId,
      codeVerifier,
      issuedAt: Date.now(),
      nonce: randomBytes(16).toString('base64url'),
    };
    const url = new URL(`${loginBase(config)}/authorize`);
    url.searchParams.set('client_id', config.clientId!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.redirectUri!);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', sealSecret(JSON.stringify(state), this.key()));
    url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    // Always ask which account: the office may be signed in to Microsoft as somebody else.
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  readState(raw: string | undefined): MicrosoftAuthState {
    const invalid = () => new MicrosoftError('The Microsoft sign-in could not be checked. Start it again.', 'MICROSOFT_STATE_INVALID', 400);
    if (!raw) throw invalid();
    const opened = openSecret(raw, this.key());
    if (!opened) throw invalid();
    let state: MicrosoftAuthState;
    try {
      state = JSON.parse(opened) as MicrosoftAuthState;
    } catch {
      throw invalid();
    }
    if (typeof state.organizationId !== 'string' || typeof state.codeVerifier !== 'string' || typeof state.issuedAt !== 'number') throw invalid();
    if (Date.now() - state.issuedAt > STATE_TTL_MS)
      throw new MicrosoftError('The Microsoft sign-in took too long. Start it again.', 'MICROSOFT_STATE_EXPIRED', 400);
    return state;
  }

  async exchange(code: string, codeVerifier: string): Promise<MicrosoftTokens> {
    const tokens = await this.postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config().redirectUri ?? '',
      code_verifier: codeVerifier,
      scope: this.config().scopes,
    });
    if (!tokens.refresh_token)
      throw new MicrosoftError('Microsoft gave no refresh token. Connect again and allow staying signed in.', 'MICROSOFT_NO_REFRESH_TOKEN', 502);
    return tokens;
  }

  /** The only writer of the token columns. */
  async store(organizationId: string, tokens: MicrosoftTokens, extra: Record<string, unknown> = {}) {
    const key = this.key();
    const credentials = {
      accessTokenCiphertext: sealSecret(tokens.access_token, key),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1_000),
      // Microsoft sends a new refresh token with each renewal; the old one may stop working.
      ...(tokens.refresh_token ? { refreshTokenCiphertext: sealSecret(tokens.refresh_token, key) } : {}),
      ...(tokens.scope ? { scopes: tokens.scope.split(' ').filter(Boolean) } : {}),
      status: 'CONNECTED',
      lastRefreshedAt: new Date(),
      lastRefreshError: null,
      ...extra,
    };
    await this.prisma.microsoftConnection.upsert({ where: { organizationId }, create: { organizationId, ...credentials }, update: credentials });
  }

  async accessToken(organizationId: string): Promise<string> {
    const connection = await this.prisma.microsoftConnection.findUnique({
      where: { organizationId },
      select: { status: true, accessTokenCiphertext: true, accessTokenExpiresAt: true },
    });
    if (!connection || connection.status !== 'CONNECTED') throw new MicrosoftError('Microsoft is not connected.', 'MICROSOFT_NOT_CONNECTED', 409);
    const fresh = connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
    if (fresh && connection.accessTokenCiphertext) {
      const token = openSecret(connection.accessTokenCiphertext, this.key());
      if (token) return token;
      await this.requireReconnect(organizationId, 'The stored Microsoft sign-in could not be read: the key changed.');
      throw new MicrosoftError('Microsoft must be connected again.', 'MICROSOFT_REAUTHORIZATION_REQUIRED', 409);
    }
    return this.refresh(organizationId);
  }

  /** One renewal at a time: two callers at once share it. */
  refresh(organizationId: string): Promise<string> {
    const running = this.inFlight.get(organizationId);
    if (running) return running;
    const attempt = this.performRefresh(organizationId).finally(() => this.inFlight.delete(organizationId));
    this.inFlight.set(organizationId, attempt);
    return attempt;
  }

  private async performRefresh(organizationId: string) {
    const connection = await this.prisma.microsoftConnection.findUnique({ where: { organizationId }, select: { refreshTokenCiphertext: true } });
    if (!connection?.refreshTokenCiphertext) throw new MicrosoftError('Microsoft is not connected.', 'MICROSOFT_NOT_CONNECTED', 409);
    const refreshToken = openSecret(connection.refreshTokenCiphertext, this.key());
    if (!refreshToken) {
      await this.requireReconnect(organizationId, 'The stored Microsoft sign-in could not be read: the key changed.');
      throw new MicrosoftError('Microsoft must be connected again.', 'MICROSOFT_REAUTHORIZATION_REQUIRED', 409);
    }
    let tokens: MicrosoftTokens;
    try {
      tokens = await this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: this.config().scopes });
    } catch (error) {
      if (error instanceof MicrosoftError && (error.providerStatus === 400 || error.providerStatus === 401))
        await this.requireReconnect(organizationId, 'Microsoft refused the stored sign-in (a changed password or a revoked consent). Connect again.');
      throw error;
    }
    await this.store(organizationId, tokens);
    return tokens.access_token;
  }

  async requireReconnect(organizationId: string, reason: string) {
    await this.prisma.microsoftConnection.updateMany({
      where: { organizationId },
      data: { status: 'REAUTHORIZATION_REQUIRED', lastRefreshError: reason, accessTokenCiphertext: null, accessTokenExpiresAt: null },
    });
    this.logger.warn({ event: 'microsoft_reconnect_required', organizationId });
  }

  /** Forget the account: the tokens go; the workbook link stays for the next connection. */
  async disconnect(organizationId: string) {
    await this.prisma.microsoftConnection.updateMany({
      where: { organizationId },
      data: { status: 'DISCONNECTED', accessTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenCiphertext: null, lastRefreshError: null },
    });
  }

  private async postToken(body: Record<string, string>): Promise<MicrosoftTokens> {
    const config = this.config();
    if (!microsoftConfigured(config)) throw new MicrosoftError('Microsoft sign-in is not set up on this server.', 'MICROSOFT_NOT_CONFIGURED', 503);
    let response: Response;
    try {
      response = await fetch(`${loginBase(config)}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: config.clientId!, client_secret: config.clientSecret!, ...body }).toString(),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch {
      throw new MicrosoftError('Microsoft could not be reached. Try again in a moment.', 'MICROSOFT_UNREACHABLE', 502);
    }
    if (!response.ok)
      throw new MicrosoftError(
        response.status === 400 || response.status === 401 ? 'Microsoft refused the sign-in.' : 'Microsoft did not answer as expected.',
        'MICROSOFT_TOKEN_REFUSED',
        502,
        response.status,
      );
    const tokens = (await response.json().catch(() => null)) as MicrosoftTokens | null;
    if (!tokens?.access_token || typeof tokens.expires_in !== 'number')
      throw new MicrosoftError('Microsoft did not answer as expected.', 'MICROSOFT_TOKEN_REFUSED', 502, response.status);
    return tokens;
  }
}
