import { Injectable } from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTHeaderParameters,
  type FlattenedJWSInput,
  type JWTVerifyGetKey,
} from 'jose';

import type { PortalSettings } from './portal.config';

/**
 * Verifies a back-channel logout token from the portal.
 *
 * The signature is the only thing that makes this endpoint safe to leave open
 * without a session or a CSRF token, so every check the OpenID back-channel
 * logout spec and IT name is made here, and anything unexpected is refused.
 */

export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** How old a logout token may be. Generous next to its own two-minute life, for delivery retries. */
const MAX_TOKEN_AGE = '10m';
const CLOCK_SKEW_SECONDS = 60;

/** How long the portal's keys are trusted before they are fetched again. */
const KEY_CACHE_MS = 10 * 60_000;
/** The least time between two key fetches, however many unknown `kid`s arrive. */
const KEY_REFETCH_COOLDOWN_MS = 30_000;
const KEY_FETCH_TIMEOUT_MS = 10_000;

export class InvalidLogoutTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid logout token: ${reason}.`);
    this.name = 'InvalidLogoutTokenError';
  }
}

@Injectable()
export class PortalLogoutTokenVerifier {
  /**
   * One key set per JWKS address, kept for the life of the process.
   *
   * jose caches the keys, fetches again on an unknown `kid` at most once per
   * cooldown, and never caches a failed fetch — the three things asked for.
   * Keyed by address so a test, or a reconfigured issuer, gets its own.
   */
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  async verify(settings: PortalSettings, token: string): Promise<{ subject: string }> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.keyFor(settings), {
        algorithms: ['RS256'],
        issuer: settings.issuer,
        audience: settings.clientId,
        typ: 'logout+jwt',
        maxTokenAge: MAX_TOKEN_AGE,
        clockTolerance: CLOCK_SKEW_SECONDS,
        requiredClaims: ['iat', 'exp', 'jti', 'sub'],
      }));
    } catch (error) {
      throw new InvalidLogoutTokenError(error instanceof Error ? error.name : 'unverifiable');
    }

    const events = payload.events;
    if (
      !events ||
      typeof events !== 'object' ||
      Array.isArray(events) ||
      typeof (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT] !== 'object' ||
      (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT] === null
    )
      throw new InvalidLogoutTokenError('missing back-channel logout event');
    // The spec forbids a nonce, so that an ID token can never pass as one of these.
    if ('nonce' in payload) throw new InvalidLogoutTokenError('nonce present');
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!subject) throw new InvalidLogoutTokenError('empty sub');
    return { subject };
  }

  private keyFor(settings: PortalSettings): JWTVerifyGetKey {
    const existing = this.keySets.get(settings.endpoints.jwks);
    if (existing) return existing;
    const remote = createRemoteJWKSet(new URL(settings.endpoints.jwks), {
      cacheMaxAge: KEY_CACHE_MS,
      cooldownDuration: KEY_REFETCH_COOLDOWN_MS,
      timeoutDuration: KEY_FETCH_TIMEOUT_MS,
    });
    // The key is the one the `kid` names, never a guess. Without this, a key set
    // holding a single key would verify a token that names none.
    const byKid: JWTVerifyGetKey = (header: JWTHeaderParameters, input: FlattenedJWSInput) => {
      if (!header.kid) throw new InvalidLogoutTokenError('no kid');
      return remote(header, input);
    };
    this.keySets.set(settings.endpoints.jwks, byKid);
    return byKid;
  }
}
