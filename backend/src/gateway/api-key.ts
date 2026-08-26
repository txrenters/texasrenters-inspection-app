import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

export type ApiKeyEnvironment = 'LIVE' | 'TEST';

/**
 * `trk_live_<prefix>.<secret>`
 *
 * The two halves do different jobs and the separator makes that visible. The
 * prefix identifies which key this is and is safe to store, index, log and show
 * in a console. The secret proves possession and is never persisted anywhere.
 *
 * The environment is carried in the credential itself so a test key pasted into
 * a production configuration is obvious on sight, rather than after it writes
 * something.
 */
export const API_KEY_PATTERN = /^trk_(live|test)_([\da-f]{12})\.([\w-]{43})$/;

/** How far a signed request's timestamp may be from ours, in seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface ParsedApiKey {
  environment: ApiKeyEnvironment;
  prefix: string;
  secret: string;
}

/**
 * The server-side hashing key.
 *
 * Required, with no fallback and no default. This follows the same rule the
 * access-token verifier settled on: unconfigured means refuse, not guess. A
 * derived or defaulted pepper would mean two deployments that never shared a
 * secret could nonetheless validate each other's keys.
 *
 * Deliberately not `AI_CREDENTIALS_ENCRYPTION_KEY`. That key protects provider
 * credentials; giving it a second, unrelated job means rotating it for one
 * reason silently invalidates the other.
 */
export function apiKeyPepper() {
  const pepper = process.env.API_KEY_PEPPER?.trim();
  if (!pepper || pepper.length < 32) return undefined;
  return pepper;
}

export function requireApiKeyPepper() {
  const pepper = apiKeyPepper();
  if (!pepper)
    throw new UnauthorizedException('Third-party API access is not configured on this deployment.');
  return pepper;
}

export function parseApiKey(value: string | undefined): ParsedApiKey | null {
  const match = value?.trim().match(API_KEY_PATTERN);
  if (!match) return null;
  return {
    environment: match[1] === 'live' ? 'LIVE' : 'TEST',
    prefix: match[2]!,
    secret: match[3]!,
  };
}

/**
 * A keyed hash of the secret.
 *
 * HMAC-SHA256 rather than bcrypt, and that is a deliberate departure from how
 * this codebase stores passwords. Slow hashing exists to make guessing a
 * human-chosen secret expensive. This secret is 256 bits from `randomBytes`,
 * so there is nothing to guess — and a deliberately slow hash on the
 * authentication path of a machine API is a self-inflicted rate limit, run
 * before the real one.
 *
 * The prefix is bound into the hash so a stored hash cannot be transplanted
 * onto a different key row and keep working.
 */
export function hashApiKeySecret(prefix: string, secret: string, pepper = requireApiKeyPepper()) {
  return createHmac('sha256', pepper).update(`${prefix}.${secret}`).digest('hex');
}

/** Constant-time comparison, so a mismatch reveals nothing about where it failed. */
export function apiKeySecretMatches(prefix: string, secret: string, storedHash: string) {
  const pepper = apiKeyPepper();
  if (!pepper) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashApiKeySecret(prefix, secret, pepper), 'hex');
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface GeneratedApiKey {
  /** The full credential. Shown once, at creation, and never recoverable. */
  key: string;
  prefix: string;
  secretHash: string;
}

export function generateApiKey(environment: ApiKeyEnvironment): GeneratedApiKey {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const label = environment === 'LIVE' ? 'live' : 'test';
  return {
    key: `trk_${label}_${prefix}.${secret}`,
    prefix,
    secretHash: hashApiKeySecret(prefix, secret),
  };
}

/**
 * What a signature covers.
 *
 * Method, path and a hash of the exact request bytes, bound to a timestamp.
 * Including the method and path stops a signature captured on a harmless GET
 * from being replayed onto a POST, which is the mistake body-only schemes make.
 */
export function signaturePayload(
  method: string,
  path: string,
  timestamp: string,
  rawBody: Buffer | string | undefined,
) {
  const body = rawBody ?? Buffer.alloc(0);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

export function computeSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  rawBody: Buffer | string | undefined,
) {
  return createHmac('sha256', secret)
    .update(signaturePayload(method, path, timestamp, rawBody))
    .digest('hex');
}

export type SignatureFailure =
  | 'missing'
  | 'malformed-timestamp'
  | 'timestamp-outside-tolerance'
  | 'mismatch';

/**
 * Verify a request signature.
 *
 * What this buys, precisely, so nobody over-reads it: replay protection and
 * integrity binding. It is **not** an independent second factor — the signing
 * key is the same secret the caller already transmits in `x-api-key`, because
 * the server stores only a hash of that secret and so has nothing else to sign
 * with. Someone holding the key can sign.
 *
 * That is still worth requiring on writes. The realistic failure it prevents is
 * not an attacker forging a request; it is the same POST arriving twice — a
 * retried proxy, a replayed capture, a misbehaving client — and creating two of
 * something that should exist once.
 */
export function verifySignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer | string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureFailure | null {
  if (!timestamp || !signature) return 'missing';
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt)) return 'malformed-timestamp';
  if (Math.abs(nowSeconds - issuedAt) > SIGNATURE_TOLERANCE_SECONDS)
    return 'timestamp-outside-tolerance';
  const expected = Buffer.from(computeSignature(secret, method, path, timestamp, rawBody), 'utf8');
  const actual = Buffer.from(signature.trim(), 'utf8');
  if (expected.length !== actual.length) return 'mismatch';
  return timingSafeEqual(expected, actual) ? null : 'mismatch';
}
