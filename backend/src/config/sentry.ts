interface SentryEventLike {
  request?: { headers?: Record<string, string | undefined> };
  extra?: Record<string, unknown>;
}

const sensitiveExtraKeys = new Set(['transcript', 'video', 'tenant', 'prompt', 'accessToken']);

/** Removes known private fields before a future Sentry transport receives an event. */
export function sanitizeMonitoringEvent<T extends SentryEventLike>(event: T): T {
  if (event.request?.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.cookie;
  }
  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (sensitiveExtraKeys.has(key)) delete event.extra[key];
    }
  }
  return event;
}
