import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Checking that a call really comes from this repository's image workflow.
 *
 * A GitHub Actions job can ask GitHub for a short-lived OpenID Connect token
 * that says who is calling: the repository, the workflow file, the event that
 * started it, the run. GitHub signs it with a key it publishes, so the server
 * checks the signature and those claims and needs nothing else. There is no
 * shared secret in the repository's settings or on the server, and so nothing
 * to leak, copy between the two, or rotate.
 *
 * Hand-rolled on node:crypto, RS256 only, like the session tokens in
 * common/auth.ts.
 */

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_ACTIONS_KEYS_URL = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`;

/** Tolerated disagreement between GitHub's clock and this server's. */
const CLOCK_SKEW_SECONDS = 60;
/** Keys GitHub has retired stop being trusted within the hour. */
const KEY_SET_MAX_AGE_MS = 60 * 60_000;
/** However many unknown key ids arrive, GitHub is asked at most this often. */
const KEY_SET_REFRESH_INTERVAL_MS = 60_000;

/** The claims of a GitHub Actions token this server reads. */
export interface GithubActionsClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  /** `owner/name`. */
  repository: string;
  /** `owner/name/.github/workflows/<file>@<ref>`. */
  workflow_ref: string;
  event_name: string;
  /** `refs/tags/v2.5.74` for a release. */
  ref: string;
  sha: string;
  run_id: string;
  run_attempt: string;
}

/** Who may call: the audience asked for, and the one workflow, run by one event, in one repository. */
export interface ExpectedCaller {
  audience: string;
  repository: string;
  /** The workflow's file name under `.github/workflows`. */
  workflow: string;
  eventName: string;
}

/** A token that is not from the expected caller, and why, for the server's log only. */
export class UnverifiedCaller extends Error {}

export type KeySetFetcher = () => Promise<unknown>;

async function fetchGithubActionsKeySet(): Promise<unknown> {
  const response = await fetch(GITHUB_ACTIONS_KEYS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for its signing keys.`);
  return response.json();
}

function parseKeySet(body: unknown) {
  const entries = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) throw new Error('GitHub published no signing keys.');
  const keys = new Map<string, KeyObject>();
  for (const entry of entries) {
    const { kid, kty } = (entry ?? {}) as { kid?: unknown; kty?: unknown };
    if (typeof kid !== 'string' || kty !== 'RSA') continue;
    try {
      keys.set(kid, createPublicKey({ key: entry as JsonWebKey, format: 'jwk' }));
    } catch {
      // A key this server cannot read signs nothing it will accept.
    }
  }
  return keys;
}

/** GitHub's published signing keys, fetched when needed and kept for the hour. */
export class GithubActionsKeys {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly fetchKeySet: KeySetFetcher = fetchGithubActionsKeySet,
    private readonly now: () => number = Date.now,
  ) {}

  /** The key GitHub publishes under `kid`, or undefined when it publishes none. */
  async key(kid: string) {
    if (!this.keys.has(kid) || this.now() - this.fetchedAt > KEY_SET_MAX_AGE_MS) await this.refresh();
    return this.keys.get(kid);
  }

  private async refresh() {
    // A key id not seen before is a rotation or a forgery. Either way GitHub is
    // asked at most once a minute, so made-up key ids cannot turn into a stream
    // of requests from this server.
    if (this.now() - this.fetchedAt < KEY_SET_REFRESH_INTERVAL_MS) return;
    this.fetchedAt = this.now();
    this.keys = parseKeySet(await this.fetchKeySet());
  }
}

function decodePart(part: string, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new UnverifiedCaller(`The token's ${name} is not JSON.`);
}

/**
 * The token's claims, once its signature and every claim that says who is
 * calling have been checked.
 *
 * @throws UnverifiedCaller when it is not from the expected caller.
 * @throws Error when GitHub's keys cannot be fetched, so nothing can be checked.
 */
export async function verifyGithubActionsToken(
  token: string,
  keys: GithubActionsKeys,
  expected: ExpectedCaller,
  now: number = Date.now(),
): Promise<GithubActionsClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new UnverifiedCaller('Not a signed token.');
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

  const header = decodePart(encodedHeader, 'header');
  // RS256 and nothing else. `none`, or HS256 "signed" with the public key, are
  // the two classic ways round a verifier that takes the header's word for it.
  if (header.alg !== 'RS256') throw new UnverifiedCaller(`Signed with ${String(header.alg)}, not RS256.`);
  if (typeof header.kid !== 'string') throw new UnverifiedCaller('The token names no signing key.');
  const key = await keys.key(header.kid);
  if (!key) throw new UnverifiedCaller('Signed with a key GitHub does not publish.');
  let signed = false;
  try {
    signed = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      key,
      Buffer.from(encodedSignature, 'base64url'),
    );
  } catch {
    // A malformed signature is a signature that does not match.
  }
  if (!signed) throw new UnverifiedCaller('The signature does not match.');

  const claims = decodePart(encodedClaims, 'claims') as Partial<GithubActionsClaims>;
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== GITHUB_ACTIONS_ISSUER) throw new UnverifiedCaller('Not issued by GitHub Actions.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) throw new UnverifiedCaller('Minted for another audience.');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= seconds)
    throw new UnverifiedCaller('Expired.');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > seconds)
    throw new UnverifiedCaller('Not valid yet.');
  if (claims.repository !== expected.repository) throw new UnverifiedCaller('From another repository.');
  // The workflow file, at whatever ref it ran from: a release runs it from the tag.
  if (
    typeof claims.workflow_ref !== 'string' ||
    !claims.workflow_ref.startsWith(`${expected.repository}/.github/workflows/${expected.workflow}@`)
  )
    throw new UnverifiedCaller('From another workflow.');
  if (claims.event_name !== expected.eventName) throw new UnverifiedCaller(`Run by ${String(claims.event_name)}.`);
  if (typeof claims.ref !== 'string' || typeof claims.sha !== 'string')
    throw new UnverifiedCaller('The token names no commit.');
  if (!/^\d+$/u.test(String(claims.run_id)) || !/^\d+$/u.test(String(claims.run_attempt)))
    throw new UnverifiedCaller('The token names no run.');
  return claims as GithubActionsClaims;
}
