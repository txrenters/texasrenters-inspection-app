import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { openSecret, readEnvelopeKey, sealSecret } from '../../common/secret-envelope';
import { getJobberConfig } from './jobber.config';
import { JOBBER_AUTH_STATE_TTL_MS, JOBBER_CODE_CHALLENGE_METHOD } from './jobber.constants';
import { JobberError } from './jobber.errors';

interface JobberAuthState {
  organizationId: string;
  userId: string | null;
  codeVerifier: string;
  issuedAt: number;
  nonce: string;
}

/**
 * Builds authorization URLs and validates what comes back on the callback.
 *
 * The callback is reached by a browser redirect from Jobber, so it cannot carry
 * our session — everything needed to finish the exchange has to survive the
 * round trip in the `state` parameter. That parameter is therefore an encrypted
 * envelope rather than a random string: it carries the organization, the PKCE
 * verifier and an issue time, so the callback needs no server-side session
 * store and keeps working across restarts and multiple API instances.
 *
 * The verifier is safe to put there only because the envelope is sealed with a
 * server-side key; the browser and Jobber both see opaque ciphertext.
 */
@Injectable()
export class JobberOAuthService {
  private readonly config = getJobberConfig();

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

  /** The URL a Jobber admin must visit to grant consent. */
  buildAuthorizationUrl(input: { organizationId: string; userId: string | null }) {
    if (!this.config.clientId || !this.config.redirectUri)
      throw new JobberError(
        'Jobber is not configured on this backend.',
        'JOBBER_NOT_CONFIGURED',
        503,
      );
    // 43-128 unreserved characters. 32 random bytes base64url-encode to 43.
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state: JobberAuthState = {
      organizationId: input.organizationId,
      userId: input.userId,
      codeVerifier,
      issuedAt: Date.now(),
      nonce: randomBytes(16).toString('base64url'),
    };
    const url = new URL(this.config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', sealSecret(JSON.stringify(state), this.key()));
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', JOBBER_CODE_CHALLENGE_METHOD);
    return url.toString();
  }

  /**
   * Recovers the authorization request behind a callback.
   *
   * Rejects anything it cannot decrypt and anything older than the ten minutes
   * an authorization code lives, so a captured URL cannot be replayed later.
   */
  readState(raw: string | undefined): JobberAuthState {
    if (!raw)
      throw new JobberError(
        'The Jobber callback was missing its state parameter.',
        'JOBBER_STATE_MISSING',
        400,
      );
    const opened = openSecret(raw, this.key());
    if (!opened)
      throw new JobberError(
        'The Jobber callback state could not be verified.',
        'JOBBER_STATE_INVALID',
        400,
      );
    let state: JobberAuthState;
    try {
      state = JSON.parse(opened) as JobberAuthState;
    } catch {
      throw new JobberError(
        'The Jobber callback state could not be verified.',
        'JOBBER_STATE_INVALID',
        400,
      );
    }
    if (
      typeof state.organizationId !== 'string' ||
      typeof state.codeVerifier !== 'string' ||
      typeof state.issuedAt !== 'number'
    )
      throw new JobberError(
        'The Jobber callback state could not be verified.',
        'JOBBER_STATE_INVALID',
        400,
      );
    if (Date.now() - state.issuedAt > JOBBER_AUTH_STATE_TTL_MS)
      throw new JobberError(
        'The Jobber authorization request expired. Start it again.',
        'JOBBER_STATE_EXPIRED',
        400,
      );
    return state;
  }

  /**
   * Constant-time comparison for the account identity check.
   *
   * Not a secret, but it decides whether an existing calendar gets replaced, so
   * it is compared the same way as anything else that gates a write.
   */
  static sameAccount(a: string | null | undefined, b: string | null | undefined) {
    if (!a || !b) return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
