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
 * the rest of the shift depends on. A minute and 25 metres is enough to say
 * which property somebody is at and which way they are going.
 */
const FIX_INTERVAL_MS = 60_000;
const FIX_DISTANCE_M = 25;

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

  const fixes: QueuedFix[] = locations.map((location) => ({
    id: fixId(),
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    // The device's own clock at the moment of the fix. The API keeps this
    // separately from when it heard about it, so a batch delivered after an
    // outage still draws the route in the order it was walked.
    recordedAt: new Date(location.timestamp).toISOString(),
    accuracyMeters:
      location.coords.accuracy === null || location.coords.accuracy === undefined
        ? null
        : Math.round(location.coords.accuracy),
  }));

  // Queued, never sent from here. This context may have no session and no
  // network, and a task that awaited an HTTP call would be killed mid-flight.
  await appendLocationFixes(fixes);
});

export type ShiftStartResult =
  | { started: true }
  | {
      started: false;
      reason: 'FOREGROUND_DENIED' | 'BACKGROUND_DENIED' | 'UNAVAILABLE' | 'UNSUPPORTED';
    };

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
  // dialogue. Refusing it is not fatal — foreground-only tracking still
  // records a shift spent inside the app — so this reports rather than throws.
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) return { started: false, reason: 'BACKGROUND_DENIED' };

  if (await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK)) return { started: true };

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
      notificationTitle: 'On shift',
      notificationBody: 'TexasRenters Inspect is recording your location.',
      killServiceOnDestroy: false,
    },
  });
  return { started: true };
}

export async function stopShiftTracking() {
  // Guarded: stopping a task that was never started throws on Android, and
  // this is called on sign-out where the shift may never have begun.
  if (!(await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false))) return;
  await Location.stopLocationUpdatesAsync(SHIFT_LOCATION_TASK).catch(() => undefined);
}

/** Whether the OS still considers the shift running — the honest source. */
export async function isShiftTrackingActive() {
  return TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false);
}
