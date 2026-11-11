import { Injectable, Logger } from '@nestjs/common';

import type { PortalSettings } from './portal.config';

/**
 * The three calls this app makes to the TR Staff Portal: exchange a code,
 * read who signed in, and refresh.
 *
 * Plain `fetch` rather than an OpenID client library. The endpoints are fixed,
 * the flow is authorization code with PKCE and nothing else, and every check
 * that matters — state, the `apps` claim, how an account is linked — is this
 * app's own and lives in the services that call this.
 *
 * Nothing here logs a request or response body. Bodies carry tokens, the
 * client secret, and the person's claims.
 */

/** About ten seconds, then the portal counts as unavailable (IT's figure). */
const PORTAL_TIMEOUT_MS = 10_000;

/** The portal said no, for a reason this app treats as final. */
export class PortalRefusedError extends Error {
  constructor(readonly status: number, readonly oauthError?: string) {
    super(`The portal refused the request (${status}${oauthError ? ` ${oauthError}` : ''}).`);
    this.name = 'PortalRefusedError';
  }
}

/** The portal could not answer: a network failure, a timeout or a 5xx. Not a refusal. */
export class PortalUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`The portal is unavailable (${reason}).`);
    this.name = 'PortalUnavailableError';
  }
}

export interface PortalUserInfo {
  sub: string;
  email?: string;
  /** Only a literal `true` counts. */
  emailVerified: boolean;
  /** The Short IDs of the apps this person may open right now. */
  apps: string[];
}

export type PortalRefreshOutcome =
  | { kind: 'renewed'; refreshToken: string }
  /** 400 invalid_grant or 401: deactivated, removed from the app, signed out everywhere, or past twelve hours. */
  | { kind: 'revoked' }
  | { kind: 'unavailable'; reason: string };

@Injectable()
export class PortalClient {
  private readonly logger = new Logger(PortalClient.name);
  /** A property only so a test can prove a timeout is an outage without waiting ten seconds. */
  timeoutMs = PORTAL_TIMEOUT_MS;

  /** Exchanges an authorization code for tokens. Throws on anything but a complete answer. */
  async exchangeCode(settings: PortalSettings, code: string, verifier: string) {
    const body = await this.tokenRequest(settings, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: settings.redirectUri,
      code_verifier: verifier,
    });
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    // Without a refresh token this session could never be checked again, and a
    // session that cannot be checked is one that cannot be taken away.
    if (!accessToken || !refreshToken) throw new PortalRefusedError(200, 'incomplete_token_response');
    return { accessToken, refreshToken };
  }

  /** Who signed in, from /oauth/userinfo, authenticated with the access token. */
  async userInfo(settings: PortalSettings, accessToken: string): Promise<PortalUserInfo> {
    const response = await this.send(settings.endpoints.userinfo, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status >= 500) throw new PortalUnavailableError(`userinfo ${response.status}`);
      throw new PortalRefusedError(response.status);
    }
    const claims = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const sub = typeof claims?.sub === 'string' ? claims.sub.trim() : '';
    if (!sub) throw new PortalRefusedError(response.status, 'userinfo_without_sub');
    return {
      sub,
      email: typeof claims?.email === 'string' ? claims.email : undefined,
      emailVerified: claims?.email_verified === true,
      apps: Array.isArray(claims?.apps)
        ? claims.apps.filter((app): app is string => typeof app === 'string')
        : [],
    };
  }

  /**
   * Refreshes a portal session.
   *
   * The distinction IT drew is the whole point of this method: a refusal means
   * access was taken away and the session must end, while an outage means
   * nothing about the person at all and the session must survive it.
   */
  async refresh(settings: PortalSettings, refreshToken: string): Promise<PortalRefreshOutcome> {
    try {
      const body = await this.tokenRequest(settings, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      // The portal rotates on every refresh. Should one ever come back without
      // a new token, the one just used is still the current one.
      const next = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : refreshToken;
      return { kind: 'renewed', refreshToken: next };
    } catch (error) {
      if (error instanceof PortalRefusedError) {
        if (error.status === 401 || (error.status === 400 && error.oauthError === 'invalid_grant'))
          return { kind: 'revoked' };
        // Any other refusal — invalid_client, a 403, a 429 — says something is
        // wrong with this app's configuration or with the portal, not with the
        // person. Signing everyone out over it would turn a typo into an outage.
        this.logger.error({
          event: 'portal_refresh_refused_unexpectedly',
          status: error.status,
          oauthError: error.oauthError,
        });
        return { kind: 'unavailable', reason: `refused ${error.status}` };
      }
      if (error instanceof PortalUnavailableError) return { kind: 'unavailable', reason: error.reason };
      throw error;
    }
  }

  /** client_secret_post: the credentials go in the form body, never in a header or the URL. */
  private async tokenRequest(settings: PortalSettings, fields: Record<string, string>) {
    const response = await this.send(settings.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        ...fields,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
      }).toString(),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && body) return body;
    if (response.status >= 500) throw new PortalUnavailableError(`token ${response.status}`);
    if (response.ok) throw new PortalUnavailableError('token response was not JSON');
    throw new PortalRefusedError(
      response.status,
      typeof body?.error === 'string' ? body.error.slice(0, 64) : undefined,
    );
  }

  private async send(url: string, init: RequestInit) {
    try {
      return await fetch(url, {
        ...init,
        // A token endpoint that redirects is not one to follow with a secret in the body.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new PortalUnavailableError(timedOut ? 'timeout' : 'network');
    }
  }
}
