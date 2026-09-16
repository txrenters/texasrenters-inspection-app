import { useEffect } from 'react';
import { AppState } from 'react-native';

import { renewSessionAhead } from '../auth/session';
import { useCurrentUser } from '../features/queries';
import { usePreferencesStore } from '../stores/preferences.store';
import { reportTracking } from './location-status';
import { ensureShiftTracking, startShiftTracking, stopShiftTracking } from './shift-tracking';

/**
 * Recording starts because the app is open, not because somebody remembered.
 *
 * It used to be a switch in Settings that a technician turned on at the start
 * of a shift and off at the end. Two taps buried two screens deep, twice a
 * day, every day — so it was forgotten in both directions, and a map of who
 * remembered to press a button is not a map of where anybody is.
 *
 * Tracking now follows the session: signed in means recording, on the road and
 * at every visit, with the app minimised or the screen locked. Signing out
 * stops it.
 *
 * Being signed in is the whole condition: the repository refuses any account
 * that is not a technician and signs it out again, so an administrator never
 * reaches this at all.
 *
 * The pause in Settings still exists, and defaults to off. The office sees when
 * it is used: every change is reported alongside the rest of how the phone is
 * recording.
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
  const signedIn = Boolean(user.data);
  const shouldTrack = signedIn && !paused;

  useEffect(() => {
    if (!shouldTrack) {
      // Covers pausing, and signing out. Safe when nothing was ever started.
      void stopShiftTracking().then(() => {
        // Said when it is the technician's own pause, so the office reads a
        // switched-off recording as that rather than as a phone gone quiet.
        // Not after signing out: there is no session to say it with.
        if (signedIn) void reportTracking({ started: false, reason: 'PAUSED' });
      });
      return;
    }

    // Failures are already reasons rather than throws, and there is nobody to
    // tell at startup: the technician did not ask for this and has no dialogue
    // open. The office is told instead, and Settings explains it on the phone.
    void startShiftTracking().then((result) => reportTracking(result));

    return () => {
      // Unmounting this means leaving the signed-in area — a sign-out, or the
      // app going away. Both should end the recording rather than leave a
      // service running for somebody who is no longer using the app.
      void stopShiftTracking();
    };
  }, [shouldTrack, signedIn]);

  /**
   * Keep the recording alive, and the session with enough life to send from a
   * pocket.
   *
   * Two triggers, because they cover different failures. Returning to the
   * foreground catches the common case — the phone comes out of a pocket at
   * the next property. The interval catches a stall while the app is *on
   * screen*, which the foreground event by definition never fires for.
   *
   * `ensureShiftTracking` restarts a recording that has gone quiet as well as
   * one that has stopped, because neither platform can tell those apart (see
   * `refreshBackgroundUpdates`).
   *
   * The session is renewed early only with the app on screen, where a renewed
   * token can be saved -- the background sends from an iPhone may not renew at
   * all, so they live on whatever this leaves them.
   */
  useEffect(() => {
    if (!shouldTrack) return;

    const check = () => {
      void ensureShiftTracking().then((result) => {
        if (AppState.currentState === 'active') void renewSessionAhead().catch(() => undefined);
        void reportTracking(result);
      });
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
