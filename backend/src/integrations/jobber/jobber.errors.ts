import { ApplicationError } from '../../common/errors';

/**
 * The status a Jobber failure should be reported to *our* caller with.
 *
 * Jobber's own 401 and 403 must never become ours. The console treats a 401 as
 * the operator's session expiring and signs them out — so a Jobber token that
 * needs refreshing would log an administrator out of this app, which is both
 * wrong and impossible to diagnose from the symptom. Both become 502: the
 * failure is upstream, and that is what a gateway status says.
 */
function callerStatusFor(providerStatus: number): number {
  return providerStatus === 401 || providerStatus === 403 ? 502 : providerStatus;
}

/**
 * A Jobber failure, carrying a status the caller actually receives.
 *
 * Extends `ApplicationError` — which is an `HttpException` — because a plain
 * `Error` is not something Nest can map. Every one of these carried a status
 * that nothing honoured, so "Jobber is not configured on this backend" and
 * "Jobber rate limit was reached" both reached the console as a bare 500
 * reading "The request could not be completed". The one message that names the
 * fix was the one the operator could not see.
 *
 * `providerStatus` is what Jobber said, kept separately because it drives
 * retry decisions: the token service refreshes once on a 401, which is not a
 * thing the caller-facing status can express.
 *
 * The default is 502 rather than 500. A Jobber failure with no status of its
 * own is an upstream problem, and saying so is the difference between "their
 * provider is down" and "this app is broken".
 */
export class JobberError extends ApplicationError {
  readonly providerStatus: number;

  constructor(
    message: string,
    code: string,
    providerStatus = 502,
    readonly retryable = false,
  ) {
    super(callerStatusFor(providerStatus), code, message);
    this.providerStatus = providerStatus;
    this.name = 'JobberError';
  }
}

/**
 * What callers are allowed to see about a Jobber failure.
 *
 * Jobber's own error bodies quote the request back, which for the token
 * endpoint means the client secret. Nothing from the provider's body reaches a
 * response or a log line; only the status is interpreted.
 */
export function sanitizedProviderMessage(status: number): string {
  if (status === 401) return 'Jobber authorization was rejected.';
  if (status === 403) return 'Jobber API permission was denied.';
  if (status === 429) return 'Jobber rate limit was reached.';
  if (status >= 500) return 'Jobber is temporarily unavailable.';
  return `Jobber request failed with HTTP ${status}.`;
}
