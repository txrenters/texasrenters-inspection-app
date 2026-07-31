import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the technician has asked the OS to reduce motion.
 *
 * Held in one module-level store rather than a hook-local subscription: the
 * skeletons render a dozen independently animating blocks on a single screen,
 * and giving each its own `AccessibilityInfo` listener would mean a dozen
 * subscriptions to a value that is identical for all of them. Callers get a
 * plain boolean and re-render when the setting changes mid-session.
 */
let reduced = false;
let started = false;
const listeners = new Set<() => void>();

function set(value: boolean) {
  if (value === reduced) return;
  reduced = value;
  for (const listener of listeners) listener();
}

function start() {
  if (started) return;
  started = true;
  // Read once for the current value, then follow changes. A technician can turn
  // the setting on while the app is open — most often precisely because
  // something on screen is making them uncomfortable.
  void AccessibilityInfo.isReduceMotionEnabled()
    .then(set)
    .catch(() => undefined);
  AccessibilityInfo.addEventListener('reduceMotionChanged', set);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Returns the cached primitive, never a fresh object: React compares snapshots
// with Object.is and would otherwise loop on "getSnapshot should be cached".
const getSnapshot = () => reduced;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam — resets the module store between cases. */
export function __resetReducedMotionForTests() {
  reduced = false;
  started = false;
  listeners.clear();
}
