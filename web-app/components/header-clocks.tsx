'use client';

import { useEffect, useState } from 'react';

import { CLOCK_ZONES, msUntilNextMinute, readClock } from '@/lib/clock';

/**
 * Manila and Texas wall-clock time, side by side in the header.
 *
 * Renders nothing until mounted. The server and the viewer's browser are in
 * different places and are never on the same second, so rendering a time during
 * SSR guarantees a hydration mismatch — and the reserved width keeps the header
 * from reflowing when the clocks appear.
 *
 * Not an `aria-live` region: a clock that announces itself every minute is
 * unusable with a screen reader. Each block carries a full description instead,
 * read on demand.
 */
export function HeaderClocks() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    let timeout: ReturnType<typeof setTimeout>;
    // Re-aligns to the boundary on every tick, so it cannot drift and does not
    // fire sixty times a minute to change nothing.
    const scheduleNextTick = () => {
      timeout = setTimeout(() => {
        setNow(new Date());
        scheduleNextTick();
      }, msUntilNextMinute(new Date()));
    };
    scheduleNextTick();
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div
      aria-hidden={now === null}
      className="hidden min-w-[168px] items-center gap-3 md:flex"
    >
      {CLOCK_ZONES.map((zone, index) => {
        const reading = now ? readClock(now, zone) : null;
        return (
          <div className="flex items-center gap-3" key={zone.id}>
            {index > 0 ? <span aria-hidden className="h-6 w-px bg-border" /> : null}
            <div
              aria-label={reading?.description}
              className="leading-tight"
              role="group"
              title={reading?.description}
            >
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {zone.label}
                </span>
                <span className="text-xs font-semibold tabular-nums text-foreground">
                  {/* Non-breaking space holds the line's height before the
                      first tick, so nothing jumps when the clock appears. */}
                  {reading?.time ?? ' '}
                </span>
              </div>
              <div className="text-[10px] tabular-nums text-muted-foreground">
                {reading ? `${reading.date} · ${reading.abbreviation}` : ' '}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
