import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobberSyncStatus } from './jobber-sync-status';

/**
 * The page previously showed only whether Jobber was *connected*, which is a
 * different fact from whether anything is being imported. The scheduler is off
 * unless three environment variables agree, and its only symptom was a last-sync
 * time quietly going stale — indistinguishable from a quiet week.
 */
describe('background sync indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (seconds: number) =>
    new Date(Date.parse('2026-09-02T10:00:00.000Z') + seconds * 1_000).toISOString();

  it('counts down to the next scheduled run', async () => {
    render(<JobberSyncStatus enabled nextRunAt={at(125)} syncing={false} cron="*/5 * * * *" />);
    // The effect runs on mount; the first tick renders the clock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Next run in 2:05/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText(/Next run in 2:00/)).toBeTruthy();
  });

  it('says a run is due rather than counting into negative numbers', async () => {
    // The cron fires on wall-clock boundaries and a run can be late. Showing
    // "-0:14" would read as a fault rather than a wait.
    render(<JobberSyncStatus enabled nextRunAt={at(-14)} syncing={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/due now/i)).toBeTruthy();
  });

  it('states the cadence when the expression is a plain interval', async () => {
    render(<JobberSyncStatus enabled nextRunAt={at(60)} syncing={false} cron="*/5 * * * *" />);
    expect(screen.getByText(/running every 5 minutes/)).toBeTruthy();
  });

  it('says nothing about cadence rather than guessing at an expression it cannot read', () => {
    // A wrong cadence in plain English is worse than none: nobody re-reads it
    // against the expression.
    render(<JobberSyncStatus enabled nextRunAt={at(60)} syncing={false} cron="0 */2 * * 1-5" />);
    expect(screen.queryByText(/every/)).toBeNull();
    expect(screen.getByText(/Background sync is running/)).toBeTruthy();
  });

  it('names the consequence when background sync is off', () => {
    // The state this component exists for. "Connected" says nothing about it.
    render(<JobberSyncStatus enabled={false} nextRunAt={null} syncing={false} />);
    expect(screen.getByText(/Background sync is off/)).toBeTruthy();
    expect(screen.getByText(/only when someone presses Sync now/)).toBeTruthy();
  });

  it('shows a run in flight instead of a countdown', async () => {
    render(<JobberSyncStatus enabled nextRunAt={at(60)} syncing cron="*/5 * * * *" />);
    expect(screen.getByText(/Syncing now/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByText(/Next run in/)).toBeNull();
  });

  it('does not announce every tick to a screen reader', () => {
    // It changes once a second. An assertive region would make the page
    // unusable; polite plus atomic reads the whole sentence when it settles.
    const { container } = render(
      <JobberSyncStatus enabled nextRunAt={at(60)} syncing={false} />,
    );
    const region = container.querySelector('[aria-live]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
  });

  it('server-renders no clock, so hydration cannot mismatch', () => {
    // The real hazard: the server's "now" is never the browser's, so a clock in
    // the SSR output is a guaranteed mismatch. Effects do not run during SSR,
    // which is why the countdown starts null — asserted here against actual
    // server output, since Testing Library flushes effects on mount and cannot
    // observe the pre-effect render.
    const html = renderToString(<JobberSyncStatus enabled nextRunAt={at(60)} syncing={false} />);
    expect(html).not.toMatch(/Next run in/);
    // The static half still renders, so the row is not blank before hydration.
    expect(html).toMatch(/Background sync is running/);
  });

  it('stops counting when there is no scheduled run to count to', async () => {
    render(<JobberSyncStatus enabled nextRunAt={null} syncing={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.queryByText(/Next run/)).toBeNull();
  });
});
