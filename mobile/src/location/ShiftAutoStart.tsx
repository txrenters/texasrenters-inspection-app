import { useEffect } from 'react';

import { useCurrentUser } from '../features/queries';
import { usePreferencesStore } from '../stores/preferences.store';
import { startShiftTracking, stopShiftTracking } from './shift-tracking';

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

  return null;
}
