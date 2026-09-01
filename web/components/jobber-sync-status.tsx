'use client';

import { useEffect, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * Whether background syncing is alive, and when it next runs.
 *
 * Being connected and being synced are different facts, and the page only ever
 * showed the first. The scheduler is off unless three environment variables
 * agree, so "connected, importing nothing" is a real state — and the only
 * previous evidence of it was a last-sync time quietly going stale, which reads
 * exactly like a quiet week.
 *
 * The countdown ticks client-side against a `nextRunAt` the server computed
 * from the cron expression. Deriving it here from an interval would drift the
 * moment a run is slow or skipped, and asking the server every second to render
 * a clock would be absurd.
 */
export function JobberSyncStatus({
  enabled,
  nextRunAt,
  syncing,
  cron,
  className,
}: {
  enabled: boolean;
  nextRunAt?: string | null;
  syncing: boolean;
  cron?: string | null;
  className?: string;
}) {
  const remaining = useCountdown(nextRunAt, enabled && !syncing);

  if (syncing)
    return (
      <Row className={className}>
        <Spinner className="size-3.5" />
        <span>
          Syncing now<Ellipsis />
        </span>
      </Row>
    );

  if (!enabled)
    return (
      <Row className={className}>
        <span aria-hidden className="bg-muted-foreground/60 size-2 rounded-full" />
        <span>
          Background sync is off. Visits import only when someone presses Sync now.
        </span>
      </Row>
    );

  return (
    <Row className={className}>
      {/* Two elements, not one: the halo animates and the dot stays put, so the
          indicator reads as a heartbeat rather than a control that grew. */}
      <span aria-hidden className="relative flex size-2">
        <span className="bg-primary/60 absolute inline-flex size-full animate-ping rounded-full motion-reduce:hidden" />
        <span className="bg-primary relative inline-flex size-2 rounded-full" />
      </span>
      <span>
        Background sync is running{describeCadence(cron)}.{' '}
        {remaining === null ? null : (
          <span className="text-foreground font-medium tabular-nums">
            {remaining <= 0 ? 'Next run due now' : `Next run in ${formatRemaining(remaining)}`}
          </span>
        )}
      </span>
    </Row>
  );
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      // Polite rather than assertive: this changes every second, and a live
      // region that interrupts on each tick makes the page unusable with a
      // screen reader. `aria-atomic` so the sentence is read whole.
      aria-atomic="true"
      aria-live="polite"
      className={cn('text-muted-foreground flex items-center gap-2 text-xs', className)}
    >
      {children}
    </p>
  );
}

/** Three dots that animate, so a long sync does not look frozen. */
function Ellipsis() {
  return (
    <span aria-hidden className="motion-reduce:hidden">
      <span className="animate-pulse [animation-delay:0ms]">.</span>
      <span className="animate-pulse [animation-delay:150ms]">.</span>
      <span className="animate-pulse [animation-delay:300ms]">.</span>
    </span>
  );
}

/**
 * Seconds until `target`, re-rendered once a second.
 *
 * Null until the first tick after mount, deliberately: rendering a clock during
 * SSR guarantees a hydration mismatch, because the server's "now" is never the
 * browser's.
 */
function useCountdown(target: string | null | undefined, active: boolean) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!target || !active) {
      setRemaining(null);
      return;
    }
    const at = new Date(target).getTime();
    if (Number.isNaN(at)) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.round((at - Date.now()) / 1_000));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [target, active]);

  return remaining;
}

function formatRemaining(seconds: number) {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * The cadence in words, for the schedules this actually runs on.
 *
 * Only a plain every-N-minutes expression is translated. Anything else is left
 * unsaid rather than guessed at — a wrong cadence in plain English is worse
 * than none, because nobody re-reads it against the expression.
 */
function describeCadence(cron?: string | null) {
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(cron?.trim() ?? '');
  if (!match) return '';
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return minutes === 1 ? ' every minute' : ` every ${minutes} minutes`;
}
