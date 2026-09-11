import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useCurrentUser } from '../features/queries';
import { usePreferencesStore } from '../stores/preferences.store';
import { ensureShiftTracking, startShiftTracking, stopShiftTracking } from './shift-tracking';

/**
 * Recording starts because the app is open, not because somebody remembered.
 *
 * It used to be a switch in Settings that a technician turned on at the start
 * of a shift and off at the end. Two taps buried two screens deep, twice a
 * day, every day — so it was forgotten in both directions, and a map of who
 * remembered to press a button is not a map of where anybody is.
 *
 * Tracking now follows the app: open and signed in means recording, closed
 * means stopped. Minimising is not closing — the phone is in a pocket for most
 * of a working day, and a trail that stopped at the bottom of every staircase
 * would be worthless.
 *
 * Being signed in is the whole condition: the repository refuses any account
 * that is not a technician and signs it out again, so an administrator never
 * reaches this at all.
 *
 * The pause in Settings still exists, and defaults to off. Automatic is the
 * point; automatic with no way to stop is a different thing, and one nobody
 * should ship to somebody else's personal phone.
 */
/**
 * How often to check that tracking is still running, while the app is open.
 *
 * Two minutes. The check is one question to the OS, so the cost is negligible;
 * the number that matters is the size of the hole a stall leaves in the trail,
 * and this bounds it at two minutes instead of the rest of the day.
 */
const RECHECK_INTERVAL_MS = 2 * 60_000;

export function ShiftAutoStart() {
  const user = useCurrentUser();
  const paused = usePreferencesStore((state) => state.locationPaused);

  // A session is enough. The repository refuses anyone who is not a technician
  // and signs them straight back out, so there is no second role check to make
  // here — and writing one anyway would imply this file is the thing keeping
  // administrators from being tracked, which it is not.
  const shouldTrack = Boolean(user.data) && !paused;

  useEffect(() => {
    if (!shouldTrack) {
      // Covers pausing, and signing out. Safe when nothing was ever started.
      void stopShiftTracking();
      return;
    }

    // Failures are already reasons rather than throws, and there is nobody to
    // tell at startup: the technician did not ask for this and has no dialogue
    // open. A refused permission simply means no trail, and Settings is where
    // that gets explained.
    void startShiftTracking();

    return () => {
      // Unmounting this means leaving the signed-in area — a sign-out, or the
      // app going away. Both should end the recording rather than leave a
      // service running for somebody who is no longer using the app.
      void stopShiftTracking();
    };
  }, [shouldTrack]);

  /**
   * Put tracking back when the OS has taken it away.
   *
   * The effect above runs once and its dependency does not change during a
   * working day, so starting there was a one-shot. Android battery managers
   * reclaim background location services aggressively and iOS terminates them
   * under memory pressure; when that happened nothing restarted it, and a
   * technician's trail stopped for the rest of the shift while the app looked
   * perfectly fine.
   *
   * Two triggers, because they cover different failures. Returning to the
   * foreground catches the common case — the phone comes out of a pocket at
   * the next property. The interval catches a stall while the app is *on
   * screen*, which the foreground event by definition never fires for.
   *
   * `ensureShiftTracking` asks the OS whether updates are running and returns
   * immediately when they are, so neither trigger costs anything in the
   * ordinary case.
   */
  useEffect(() => {
    if (!shouldTrack) return;

    const check = () => {
      void ensureShiftTracking();
    };

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    const timer = setInterval(check, RECHECK_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [shouldTrack]);

  return null;
}
