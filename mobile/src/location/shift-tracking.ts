import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { appendLocationFixes } from './location-storage';
import type { QueuedFix } from './location-queue';

/**
 * Recording where a technician is while they are on shift.
 *
 * Behind a toggle they set themselves, and never simply "while signed in".
 * Tracking somebody at home in the evening is neither useful to dispatch nor
 * defensible to the person being tracked, and an app that starts on its own is
 * one nobody can tell is running.
 *
 * The Android foreground-service notification is not an inconvenience to be
 * minimised — it is the thing that makes "they were told" true minute to
 * minute rather than only in a document they signed once.
 */

export const SHIFT_LOCATION_TASK = 'texasrenters-shift-location';

/**
 * How often a fix is wanted, and how far the technician must move to earn one.
 *
 * `Balanced` rather than `BestForNavigation`: this runs all day on a handset
 * that also films video, and metre-accurate positioning would cost the battery
 * the rest of the shift depends on.
 *
 * Fifteen seconds rather than the minute it used to be. A minute is fine for
 * "which property is she at" and useless for watching somebody move -- a van
 * covers half a mile between fixes, so the console drew a technician
 * teleporting between two points on a road it never showed them taking. The
 * cost is real and worth naming: more frequent fixes mean more battery, on a
 * phone that is also filming video.
 */
const FIX_INTERVAL_MS = 15_000;
const FIX_DISTANCE_M = 10;

/** Same shape the camera uses for snapshot ids — no new dependency for this. */
function fixId() {
  return `fix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Defined at module load, because the OS may deliver a batch to a process it
 * started itself with no app on screen. A task registered inside a component
 * would not exist yet when that happens.
 */
TaskManager.defineTask(SHIFT_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locations?.length) return;

  // The device's own clock at the moment of each fix. The API keeps that
  // separately from when it heard about it, so a batch delivered after an
  // outage still draws the route in the order it was walked.
  const fixes: QueuedFix[] = locations.map(toQueuedFix);

  // Queued, never sent from here. This context may have no session and no
  // network, and a task that awaited an HTTP call would be killed mid-flight.
  await appendLocationFixes(fixes);
});

/**
 * How the shift is being recorded.
 *
 * `FOREGROUND_ONLY` is a real mode rather than a degraded one: it records every
 * fix while the app is on screen, which is most of a walkthrough. It runs when
 * background permission is refused, and it is the only thing Expo Go can do at
 * all -- background location needs a development build.
 */
export type ShiftMode = 'BACKGROUND' | 'FOREGROUND_ONLY';

export type ShiftStartResult =
  | { started: true; mode: ShiftMode }
  | { started: false; reason: 'FOREGROUND_DENIED' | 'UNAVAILABLE' | 'UNSUPPORTED' };

/**
 * The foreground watcher, when the background task is not available.
 *
 * Module scope because it has to be stoppable from `stopShiftTracking`, which
 * is called from sign-out and from the toggle, neither of which holds a
 * reference to whatever started it.
 */
let foregroundWatch: Location.LocationSubscription | null = null;

/** One fix, in the shape the queue stores. Shared by both modes. */
function toQueuedFix(location: Location.LocationObject): QueuedFix {
  return {
    id: fixId(),
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    recordedAt: new Date(location.timestamp).toISOString(),
    accuracyMeters:
      location.coords.accuracy === null || location.coords.accuracy === undefined
        ? null
        : Math.round(location.coords.accuracy),
  };
}

/**
 * Turn shift tracking on, and never throw doing it.
 *
 * Every failure is a returned reason, because the caller toggles a switch and
 * has to put it back. A throw here surfaced as
 * `Uncaught (in promise) Error: One of the NSLocation*UsageDescription keys
 * must be present in Info.plist` — the app's own error screen, from tapping a
 * setting.
 *
 * `requestForegroundPermissionsAsync` is the one that does it. On a binary
 * whose Info.plist has no location strings it **throws** rather than reporting
 * denial, which is every build made before `expo-location` was added, and Expo
 * Go. The app config declares those strings correctly; a handset running an
 * older binary against a current bundle does not have them, and that is
 * ordinary during development.
 *
 * `UNSUPPORTED` is kept distinct from `UNAVAILABLE` because they are fixed in
 * different places, and the old copy sent people to the wrong one: "location
 * services are switched off" is useless advice when the truth is that this
 * build cannot do location at all.
 */
export async function startShiftTracking(): Promise<ShiftStartResult> {
  try {
    return await beginShiftTracking();
  } catch {
    return { started: false, reason: 'UNSUPPORTED' };
  }
}

async function beginShiftTracking(): Promise<ShiftStartResult> {
  if (!(await Location.hasServicesEnabledAsync().catch(() => false)))
    return { started: false, reason: 'UNAVAILABLE' };

  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) return { started: false, reason: 'FOREGROUND_DENIED' };

  // Asked second, and separately, because that is how both platforms present
  // it: iOS will not offer "always" until "while using" is granted, and
  // Android 11 upward sends the technician to Settings rather than showing a
  // dialogue.
  //
  // Refusing it is **not** fatal, and used to be treated as though it were:
  // this returned BACKGROUND_DENIED and started nothing at all. A technician
  // who granted "while using" got no tracking, and Expo Go -- which cannot do
  // background location under any circumstances -- could never start a shift.
  // The comment here already claimed foreground-only worked; the code simply
  // never did it.
  const background = await Location.requestBackgroundPermissionsAsync().catch(() => ({
    granted: false,
  }));

  if (background.granted && (await startBackgroundUpdates()))
    return { started: true, mode: 'BACKGROUND' };

  // Either permission was refused, or it was held and the task would not start
  // -- Expo Go, or a binary without the background mode. Foreground recording
  // is still worth having, and is what was granted.
  await watchInForeground();
  return { started: true, mode: 'FOREGROUND_ONLY' };
}

/**
 * Records while the app is on screen.
 *
 * `watchPositionAsync` rather than a registered task, because a background task
 * requires background permission by definition. This stops when the app leaves
 * the foreground, which is the honest limit of what was granted.
 */
async function watchInForeground() {
  if (foregroundWatch) return;
  foregroundWatch = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: FIX_INTERVAL_MS,
      distanceInterval: FIX_DISTANCE_M,
    },
    (location) => {
      // Queued, not sent: the same path the background task uses, so a fix
      // recorded in either mode reaches the office the same way.
      void appendLocationFixes([toQueuedFix(location)]);
    },
  );
}

/** Whether the OS accepted the background task. */
async function startBackgroundUpdates(): Promise<boolean> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK)) return true;

    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: FIX_INTERVAL_MS,
    distanceInterval: FIX_DISTANCE_M,
    // Never pause. iOS will otherwise decide a stationary device needs no
    // updates and stop delivering, and a technician working inside one
    // property for an hour looks identical to one who has gone home.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Recording your location',
        notificationBody: 'TexasRenters Inspect is on. Close the app to stop.',
        // Stops when the app is closed, keeps running when it is merely
        // minimised -- which is the whole working day, since the phone is in a
        // pocket between rooms. `false` kept the service alive after the app
        // was swiped away, which is tracking somebody who has finished, and is
        // the one behaviour nobody would think to check for.
        killServiceOnDestroy: true,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function stopShiftTracking() {
  foregroundWatch?.remove();
  foregroundWatch = null;

  // Guarded: stopping a task that was never started throws on Android, and
  // this is called on sign-out where the shift may never have begun.
  if (!(await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false))) return;
  await Location.stopLocationUpdatesAsync(SHIFT_LOCATION_TASK).catch(() => undefined);
}

/**
 * Whether a shift is running, in either mode.
 *
 * The registered task is the honest source for background tracking: it
 * survives the app being killed, so a stored flag would drift. A foreground
 * watch cannot survive that, so its own handle is the only thing that knows.
 */
export async function isShiftTrackingActive() {
  if (foregroundWatch) return true;
  return TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false);
}
