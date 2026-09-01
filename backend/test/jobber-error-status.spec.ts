import { HttpException } from '@nestjs/common';

import { ApplicationError } from '../src/common/errors';
import { JobberError } from '../src/integrations/jobber/jobber.errors';

/**
 * Connecting Jobber on a backend that had no `JOBBER_*` variables answered
 * `500 The request could not be completed`. The code raises a 503 saying
 * "Jobber is not configured on this backend" — the one message that names the
 * fix — and nothing carried it: `JobberError` extended plain `Error`, which
 * Nest cannot map, so every Jobber failure collapsed to the same opaque 500.
 */
describe('what a Jobber failure tells the caller', () => {
  it('is something Nest can map at all', () => {
    const error = new JobberError('Jobber is not configured on this backend.', 'X', 503);
    expect(error).toBeInstanceOf(HttpException);
    expect(error).toBeInstanceOf(ApplicationError);
  });

  it('reports the status the code chose', () => {
    expect(new JobberError('not configured', 'JOBBER_NOT_CONFIGURED', 503).getStatus()).toBe(503);
    expect(new JobberError('not connected', 'JOBBER_NOT_CONNECTED', 409).getStatus()).toBe(409);
    expect(new JobberError('rate limited', 'JOBBER_THROTTLED', 429).getStatus()).toBe(429);
  });

  it('keeps the message, which is the part that names the fix', () => {
    const error = new JobberError('Jobber is not configured on this backend.', 'X', 503);
    expect(error.message).toBe('Jobber is not configured on this backend.');
    expect(error.code).toBe('X');
  });

  it('never reports a provider 401 as our own 401', () => {
    // The console reads a 401 as the operator's session expiring and signs them
    // out. A Jobber token needing a refresh would log an administrator out of
    // this app — wrong, and impossible to diagnose from the symptom.
    const error = new JobberError('Jobber authorization was rejected.', 'X', 401);
    expect(error.getStatus()).toBe(502);
  });

  it('never reports a provider 403 as our own 403 either', () => {
    expect(new JobberError('Jobber API permission was denied.', 'X', 403).getStatus()).toBe(502);
  });

  it('still remembers what Jobber actually said, because a retry depends on it', () => {
    // The token service refreshes once on a provider 401. That decision cannot
    // be made from the caller-facing status, which is deliberately 502.
    const error = new JobberError('Jobber authorization was rejected.', 'X', 401);
    expect(error.providerStatus).toBe(401);
  });

  it('treats a failure with no status of its own as upstream, not as our fault', () => {
    // 502 rather than 500: the difference between "their provider is down" and
    // "this app is broken".
    expect(new JobberError('something went wrong', 'X').getStatus()).toBe(502);
  });

  it('carries retryability through, which the outbox drains on', () => {
    expect(new JobberError('down', 'X', 503, true).retryable).toBe(true);
    expect(new JobberError('down', 'X', 503).retryable).toBe(false);
  });
});

/**
 * The console polls this every two seconds while a run is in flight, so
 * "in progress" has to become false on its own. `lastSyncCompletedAt` is only
 * written on success, and a failed run therefore satisfied started > completed
 * for ever — the page said "Syncing now…" indefinitely and kept polling to say
 * it. `lastSyncError` is cleared at the start of every run, so its presence
 * means the *last* run failed rather than some older one.
 */
describe('whether a sync is still running', () => {
  const at = (iso: string) => new Date(iso);
  const inProgress = (c: {
    lastSyncStartedAt: Date | null;
    lastSyncCompletedAt: Date | null;
    lastSyncError: string | null;
  }) =>
    c.lastSyncStartedAt !== null &&
    (c.lastSyncCompletedAt === null || c.lastSyncStartedAt > c.lastSyncCompletedAt) &&
    c.lastSyncError === null;

  it('is running while a started run has not finished', () => {
    expect(
      inProgress({
        lastSyncStartedAt: at('2026-09-01T21:15:00Z'),
        lastSyncCompletedAt: null,
        lastSyncError: null,
      }),
    ).toBe(true);
  });

  it('is not running once a run has failed', () => {
    expect(
      inProgress({
        lastSyncStartedAt: at('2026-09-01T21:15:00Z'),
        lastSyncCompletedAt: null,
        lastSyncError: 'Foreign key constraint violated',
      }),
    ).toBe(false);
  });

  it('is not running after a successful run', () => {
    expect(
      inProgress({
        lastSyncStartedAt: at('2026-09-01T21:15:00Z'),
        lastSyncCompletedAt: at('2026-09-01T21:15:06Z'),
        lastSyncError: null,
      }),
    ).toBe(false);
  });

  it('is running again when a new run starts after an older failure', () => {
    // The error is nulled at the start of a run, which is what makes the flag
    // recover rather than latch.
    expect(
      inProgress({
        lastSyncStartedAt: at('2026-09-01T21:20:00Z'),
        lastSyncCompletedAt: at('2026-09-01T21:15:06Z'),
        lastSyncError: null,
      }),
    ).toBe(true);
  });
});
