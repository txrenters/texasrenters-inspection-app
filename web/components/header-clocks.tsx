'use client';

import { useEffect, useState } from 'react';

import { CLOCK_ZONES, msUntilNextMinute, readClock } from '@/lib/clock';

/**
 * Manila and Texas wall-clock time in the header.
 *
 * Renders a reserved-width placeholder until mounted. The server and the
 * viewer's browser are in different places and are never on the same second, so
 * rendering a time during SSR guarantees a hydration mismatch — and the reserved
 * width keeps the header from reflowing when the clocks appear.
 *
 * Not an `aria-live` region: a clock that announces itself every minute is
 * unusable with a screen reader. Each block carries a full description instead,
 * read on demand.
 *
 * One line per zone rather than the old two-line stack — the date and timezone
 * abbreviation moved into the accessible description and the tooltip, which is
 * where they were actually being read from anyway.
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
    <div aria-hidden={now === null} className="hidden items-center gap-3 lg:flex">
      {CLOCK_ZONES.map((zone) => {
        const reading = now ? readClock(now, zone) : null;
        return (
          <div
            aria-label={reading?.description}
            className="flex items-baseline gap-1.5 text-xs leading-none"
            key={zone.id}
            role="group"
            title={reading?.description}
          >
            <span className="text-muted-foreground font-medium">{zone.label}</span>
            <span className="font-medium tabular-nums">
              {/* Non-breaking space holds the line's height before the first
                  tick, so nothing jumps when the clock appears. */}
              {reading?.time ?? ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}
