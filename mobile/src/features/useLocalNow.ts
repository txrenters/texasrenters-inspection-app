import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * The current local time, kept fresh while the screen is open.
 *
 * Two things go stale without this, both on a screen a technician leaves open
 * all day: the greeting never crosses noon, and the date line still says
 * yesterday after midnight. Both were computed once at render.
 *
 * A minute is the coarsest tick that still lands on an hour boundary promptly,
 * and it only sets state when the minute actually changes, so a screen sitting
 * idle re-renders sixty times an hour rather than continuously.
 *
 * Foregrounding also re-reads the clock. A phone asleep from 11:00 to 14:00
 * gets no timers, so without this it would wake still saying "Good morning"
 * until the next tick.
 */
export function useLocalNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const sync = () =>
      setNow((current) => {
        const next = new Date();
        // Compared by minute rather than assigned unconditionally: a new Date
        // is a new object every tick, and returning it would re-render every
        // consumer whether or not anything they display had changed.
        return next.getMinutes() === current.getMinutes() &&
          next.getHours() === current.getHours() &&
          next.getDate() === current.getDate()
          ? current
          : next;
      });

    const timer = setInterval(sync, 30_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') sync();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  return now;
}
