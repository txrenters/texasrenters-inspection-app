export class JobberError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
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
