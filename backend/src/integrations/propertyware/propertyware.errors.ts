export class PropertywareError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PropertywareError';
  }
}

export function sanitizedProviderMessage(status: number): string {
  if (status === 401) return 'Propertyware credentials were rejected.';
  if (status === 403) return 'Propertyware API permission was denied.';
  if (status === 429) return 'Propertyware rate limit was reached.';
  if (status >= 500) return 'Propertyware is temporarily unavailable.';
  return `Propertyware request failed with HTTP ${status}.`;
}
