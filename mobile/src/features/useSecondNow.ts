import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * The time to the second, for a running job's time tracker.
 *
 * Only while `running`: a job that is not running has nothing to count, and a
 * screen ticking every second for nothing re-renders every second. Stopped
 * while the app is in the background, where nobody is looking, and read again
 * on foregrounding, so the tracker never wakes showing the second the phone
 * went to sleep. `useLocalNow` is the minute clock for everything else.
 */
export function useSecondNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      tick();
      if (!timer) timer = setInterval(tick, 1000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    start();
    const subscription = AppState.addEventListener('change', (state) => (state === 'active' ? start() : stop()));
    return () => {
      stop();
      subscription.remove();
    };
  }, [running]);

  return now;
}
