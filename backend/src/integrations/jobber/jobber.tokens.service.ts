import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import { openSecret, readEnvelopeKey, sealSecret } from '../../common/secret-envelope';
import { getJobberConfig } from './jobber.config';
import { JOBBER_TOKEN_EXPIRY_SKEW_MS } from './jobber.constants';
import { JobberError, sanitizedProviderMessage } from './jobber.errors';
import type { JobberTokenResponse } from './jobber.types';

/**
 * Owns the OAuth tokens for each organization's Jobber connection.
 *
 * Every other part of the integration asks this service for a bearer token and
 * is never handed the refresh token, so there is exactly one place in the
 * codebase that can write the credential columns.
 */
@Injectable()
export class JobberTokenService {
  private readonly logger = new Logger(JobberTokenService.name);
  private readonly config = getJobberConfig();

  /**
   * In-flight refreshes, keyed by organization.
   *
   * Jobber rotates refresh tokens. Two concurrent refreshes both spend the same
   * one; the slower response then overwrites the faster with a token Jobber has
   * already retired, and the connection dies at the *next* refresh — with no
   * failure at the moment the mistake was made. Collapsing them onto one
   * promise is what prevents that, and it belongs here because the sync worker
   * and an admin request can both trigger a refresh in the same second.
   */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private key() {
    const key = readEnvelopeKey(
      process.env.JOBBER_TOKEN_ENCRYPTION_KEY,
      'JOBBER_TOKEN_ENCRYPTION_KEY',
    );
    if (!key)
      throw new JobberError(
        'Secure Jobber token storage is not configured on the backend.',
        'JOBBER_TOKEN_STORAGE_NOT_CONFIGURED',
        503,
      );
    return key;
  }

  /** A bearer token valid right now, refreshing first if it is close to expiry. */
  async getAccessToken(organizationId: string): Promise<string> {
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: { status: true, accessTokenCiphertext: true, accessTokenExpiresAt: true },
    });
    if (!connection || connection.status !== JobberConnectionStatus.CONNECTED)
      throw new JobberError(
        'This organization has not authorized Jobber.',
        'JOBBER_NOT_CONNECTED',
        409,
      );
    const stillValid =
      connection.accessTokenExpiresAt !== null &&
      connection.accessTokenExpiresAt.getTime() - JOBBER_TOKEN_EXPIRY_SKEW_MS > Date.now();
    if (stillValid && connection.accessTokenCiphertext) {
      const token = openSecret(connection.accessTokenCiphertext, this.key());
      if (token) return token;
      // An unreadable envelope means the encryption key changed under us. The
      // refresh token is equally unreadable, so refreshing cannot recover it.
      await this.requireReauthorization(organizationId, 'Stored tokens could not be decrypted.');
      throw new JobberError(
        'Jobber must be authorized again.',
        'JOBBER_REAUTHORIZATION_REQUIRED',
        409,
      );
    }
    return this.refresh(organizationId);
  }

  /** Exchanges an authorization code for the first token pair. */
  async exchangeAuthorizationCode(input: {
    organizationId: string;
    code: string;
    codeVerifier: string;
    connectedByUserId?: string | null;
  }) {
    const payload = await this.postToken({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri ?? '',
      code_verifier: input.codeVerifier,
    });
    if (!payload.refresh_token)
      throw new JobberError(
        'Jobber did not return a refresh token.',
        'JOBBER_NO_REFRESH_TOKEN',
        502,
      );
    await this.store(input.organizationId, payload, {
      connectedByUserId: input.connectedByUserId ?? null,
      firstConnection: true,
    });
    return payload.access_token;
  }

  /** Redeems the refresh token, collapsing concurrent callers onto one request. */
  async refresh(organizationId: string): Promise<string> {
    const existing = this.inFlight.get(organizationId);
    if (existing) return existing;
    const attempt = this.performRefresh(organizationId).finally(() => {
      this.inFlight.delete(organizationId);
    });
    this.inFlight.set(organizationId, attempt);
    return attempt;
  }

  private async performRefresh(organizationId: string): Promise<string> {
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: { refreshTokenCiphertext: true },
    });
    const sealed = connection?.refreshTokenCiphertext;
    if (!sealed)
      throw new JobberError(
        'This organization has not authorized Jobber.',
        'JOBBER_NOT_CONNECTED',
        409,
      );
    const refreshToken = openSecret(sealed, this.key());
    if (!refreshToken) {
      await this.requireReauthorization(organizationId, 'Stored tokens could not be decrypted.');
      throw new JobberError(
        'Jobber must be authorized again.',
        'JOBBER_REAUTHORIZATION_REQUIRED',
        409,
      );
    }
    let payload: JobberTokenResponse;
    try {
      payload = await this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch (error) {
      // A rejected refresh token is terminal: Jobber revoked it, and retrying on
      // a schedule would only keep failing. Anything else — a 500, a timeout —
      // leaves the connection CONNECTED so the next sync can try again.
      if (error instanceof JobberError && error.status === 401)
        await this.requireReauthorization(organizationId, error.message);
      throw error;
    }
    await this.store(organizationId, payload, { connectedByUserId: null, firstConnection: false });
    return payload.access_token;
  }

  private async store(
    organizationId: string,
    payload: JobberTokenResponse,
    options: { connectedByUserId: string | null; firstConnection: boolean },
  ) {
    const key = this.key();
    const credentials = {
      accessTokenCiphertext: sealSecret(payload.access_token, key),
      accessTokenExpiresAt: new Date(Date.now() + payload.expires_in * 1_000),
      // Jobber returns a new refresh token only when rotation is enabled. When
      // it is absent the stored one is still current and must be left alone.
      ...(payload.refresh_token
        ? { refreshTokenCiphertext: sealSecret(payload.refresh_token, key) }
        : {}),
      status: JobberConnectionStatus.CONNECTED,
      lastRefreshedAt: new Date(),
      lastRefreshError: null,
      apiVersion: this.config.apiVersion,
      ...(options.firstConnection
        ? {
            connectedAt: new Date(),
            disconnectedAt: null,
            connectedByUserId: options.connectedByUserId,
          }
        : {}),
    };
    await this.prisma.jobberConnection.upsert({
      where: { organizationId },
      create: { organizationId, ...credentials },
      update: credentials,
    });
  }

  private async requireReauthorization(organizationId: string, reason: string) {
    await this.prisma.jobberConnection.updateMany({
      where: { organizationId },
      data: {
        status: JobberConnectionStatus.REAUTHORIZATION_REQUIRED,
        lastRefreshError: reason,
        accessTokenCiphertext: null,
        accessTokenExpiresAt: null,
      },
    });
    this.logger.warn(`Jobber connection for ${organizationId} needs re-authorization: ${reason}`);
  }

  /** Clears credentials after a disconnect, keeping the account identity. */
  async markDisconnected(organizationId: string) {
    await this.prisma.jobberConnection.updateMany({
      where: { organizationId },
      data: {
        status: JobberConnectionStatus.DISCONNECTED,
        accessTokenCiphertext: null,
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        disconnectedAt: new Date(),
      },
    });
  }

  private async postToken(fields: Record<string, string>): Promise<JobberTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.clientId ?? '',
      client_secret: this.config.clientSecret ?? '',
      ...fields,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } catch {
      // A thrown fetch error can carry the request — and therefore the client
      // secret — so it is replaced here rather than wrapped.
      throw new JobberError('Jobber could not be reached.', 'JOBBER_UNREACHABLE', 504, true);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok)
      throw new JobberError(
        sanitizedProviderMessage(response.status),
        'JOBBER_TOKEN_REQUEST_FAILED',
        response.status,
        response.status === 429 || response.status >= 500,
      );
    const payload = (await response.json()) as JobberTokenResponse;
    if (!payload?.access_token || !payload?.expires_in)
      throw new JobberError(
        'Jobber returned an unusable token response.',
        'JOBBER_TOKEN_MALFORMED',
        502,
      );
    return payload;
  }
}
