import { useEffect, useState } from 'react';

/**
 * A value once it has stopped changing for `delayMs` -- a search typed into a
 * field reaches the server after the pause, not on every key. Shared by the
 * Search tab and the Jobs screen's own search.
 */
export function useDebounced<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
