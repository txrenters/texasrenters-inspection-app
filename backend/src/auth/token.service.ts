import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { expectedTokenAudience, expectedTokenIssuer } from '../common/auth';
import { ApplicationError } from '../common/errors';

/**
 * Mints the access and refresh tokens that replace Supabase's.
 *
 * HS256, hand-rolled on `node:crypto`, and deliberately without a JWT library:
 * `verifySupabaseJwt` in common/auth.ts already verifies this shape with
 * `createHmac` and a `timingSafeEqual`, so minting is that same operation in
 * reverse. A dependency here would add a second implementation of an algorithm
 * we already have, and the two could drift.
 *
 * Issuer and audience come from the Phase 0 seam, so tokens minted here carry
 * whatever the deployment is configured to accept — including, by default, the
 * Supabase values. That is what lets both systems issue valid tokens at once
 * while the migration runs, and makes the cutover a config change.
 */

/** Supabase's own default was one hour; matching it keeps session feel unchanged. */
const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TTL_DAYS = 30;

export interface AccessToken {
  token: string;
  /** Seconds until expiry, which is what OAuth-shaped clients expect. */
  expiresIn: number;
  expiresAt: Date;
}

export interface RefreshTokenMaterial {
  /** Returned to the caller once. Never stored. */
  token: string;
  /** What goes in the database in its place. */
  tokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  /**
   * The signing key, resolved the same way verification resolves it.
   *
   * Same fallback chain as `verifySupabaseJwt` on purpose — if the two ever
   * disagreed, this service would happily mint tokens the guard rejects, and
   * every sign-in would succeed then fail on the next request.
   */
  private secret() {
    const secret = process.env.AUTH_JWT_SECRET?.trim() || process.env.SUPABASE_JWT_SECRET;
    if (!secret)
      throw new ApplicationError(
        503,
        'AUTH_NOT_CONFIGURED',
        'Token signing is not configured.',
      );
    return secret;
  }

  private accessTtlSeconds() {
    const raw = Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ACCESS_TTL_SECONDS;
  }

  private refreshTtlMs() {
    const raw = Number(process.env.AUTH_REFRESH_TOKEN_TTL_DAYS);
    const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_TTL_DAYS;
    return days * 24 * 60 * 60 * 1000;
  }

  /**
   * An access token for this identity.
   *
   * `app_metadata.must_change_password` is minted from the database column
   * rather than carried between tokens. In Supabase that flag lived only in the
   * JWT and could not be cleared without issuing a new one, which is why the
   * two clients ended up reading it from different places — web from the claim,
   * mobile from `/auth/me`. Sourcing it here makes the column authoritative
   * while keeping the claim the guards already read.
   */
  issueAccessToken(input: { authUserId: string; mustChangePassword: boolean }): AccessToken {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresIn = this.accessTtlSeconds();
    const exp = issuedAt + expiresIn;

    const header = this.encode({ alg: 'HS256', typ: 'JWT' });
    const payload = this.encode({
      sub: input.authUserId,
      iss: expectedTokenIssuer(),
      aud: expectedTokenAudience(),
      iat: issuedAt,
      exp,
      app_metadata: { must_change_password: input.mustChangePassword },
    });
    const signature = createHmac('sha256', this.secret())
      .update(`${header}.${payload}`)
      .digest('base64url');

    return { token: `${header}.${payload}.${signature}`, expiresIn, expiresAt: new Date(exp * 1000) };
  }

  /**
   * A refresh token and the hash to store instead of it.
   *
   * 256 bits from the CSPRNG, not a JWT: this token carries no claims and is
   * only ever looked up, so signing it would add structure an attacker could
   * read for nothing in return.
   */
  createRefreshToken(): RefreshTokenMaterial {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: this.hashRefreshToken(token),
      expiresAt: new Date(Date.now() + this.refreshTtlMs()),
    };
  }

  /**
   * SHA-256, not bcrypt.
   *
   * Deliberate, and the opposite of the choice for passwords. This value is 256
   * bits of CSPRNG output, so there is no dictionary to attack and no work
   * factor worth paying — and refresh runs on every expired access token, where
   * a deliberately slow hash would be felt. Passwords are low-entropy and human
   * chosen, which is what bcrypt exists for.
   */
  hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Compare two token hashes without leaking where they diverge.
   *
   * Lookups are by unique index so this is not on the hot path, but a
   * hash-to-hash comparison written with `===` is the kind of thing that gets
   * copied into somewhere it does matter.
   */
  hashesMatch(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private encode(value: unknown) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }
}
