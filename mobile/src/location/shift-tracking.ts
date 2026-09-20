import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { normaliseMotion } from '@texasrenters/shared';
import { AppState } from 'react-native';

import { sendRecordedFixes } from './location-sender';
import { appendLocationFixes, readLastFixAt } from './location-storage';
import type { QueuedFix } from './location-queue';

/**
 * Recording where a technician is, the whole time they are signed in.
 *
 * On the road as well as at the property: the office plans routes and times
 * visits from this trail, and a trail with every drive missing measures
 * nothing. So recording carries on with the app minimised, with the screen
 * locked, and -- on Android -- after the app is swiped away. Signing out stops
 * it, and so does the pause in Settings.
 *
 * Never hidden. Android shows its foreground-service notification for as long
 * as recording runs, and iOS its blue location indicator whenever the app is
 * not on screen: the technician can always see that it is on.
 */

export const SHIFT_LOCATION_TASK = 'texasrenters-shift-location';

/**
 * How often a fix is wanted, and how far the technician must move to earn one.
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

/**
 * `High`, which is satellites, rather than the `Balanced` this used to be.
 *
 * Balanced was chosen for the battery, and it cannot answer what the office
 * map now asks: how fast, and which way. Android's balanced mode positions a
 * phone from Wi-Fi and cell towers, and a fix from those carries no speed or
 * course -- Android reports both as zero, so a technician doing sixty on the
 * freeway read as standing still. iOS answers `-1` for the same reason. Worse,
 * away from Wi-Fi a tower fix is often hundreds of metres wide, and anything
 * past `MAX_USEFUL_ACCURACY_M` is refused, so a highway drive could produce no
 * usable fixes at all.
 *
 * Not `BestForNavigation`: on iOS that adds sensor fusion a technician map does
 * not need. The cost is the battery, on a phone that also films video. If that
 * proves too much, this is the one line to change -- the console derives motion
 * from successive fixes when the handset reports none.
 */
const FIX_ACCURACY = Location.Accuracy.High;

/**
 * What the background task runs with. One object, because the task is started
 * in one place and has its options brought up to date in another, and the two
 * must never disagree.
 */
export const BACKGROUND_UPDATES: Location.LocationTaskOptions = {
  accuracy: FIX_ACCURACY,
  timeInterval: FIX_INTERVAL_MS,
  distanceInterval: FIX_DISTANCE_M,
  // Never pause. iOS will otherwise decide a stationary device needs no
  // updates and stop delivering, and a technician working inside one
  // property for an hour looks identical to one who has gone home.
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'Recording your location',
    notificationBody: 'TexasRenters Inspect records your location while you are signed in.',
    /**
     * Kept running when the app is swiped away.
     *
     * This was `true`, on the view that closing the app meant the day was
     * over. It does not: technicians clear their recent apps between visits
     * as a habit, and every one of those ended the recording in the middle of
     * the working day -- the drives the office most needs were the ones that
     * went missing. The notification stays up the whole time, so it is never
     * running unseen; signing out, or the pause in Settings, stops it.
     */
    killServiceOnDestroy: false,
  },
};

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

  // Queued first, so nothing recorded depends on the send below succeeding.
  await appendLocationFixes(fixes);

  // Then sent from here, and this is what makes the office map live. The task
  // is the only code that runs while the phone is in a pocket: the sender's
  // timer is JavaScript, which Android stops the moment the app leaves the
  // screen, so a whole drive used to wait on the handset and arrive in one
  // batch at the next property. It used to be deliberately queue-only, for
  // fear of a request killed mid-flight or a context with no session -- both
  // now harmless: fixes leave the queue only once the API has them, the API
  // discards a repeat by `deviceFixId`, and with no usable session the send
  // simply leaves them for the app.
  await sendRecordedFixes();
});

/**
 * How the shift is being recorded.
 *
 * - `BACKGROUND` -- the registered task, which keeps recording with the app
 *   minimised or the screen locked.
 * - `FOREGROUND_ONLY` -- a watcher that stops the moment the app leaves the
 *   screen. Only where the task cannot start at all: Expo Go, or a binary
 *   built without the background mode.
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
    // Course and ground speed, which both platforms already put in every fix.
    // `normaliseMotion` is doing real work here rather than tidying types:
    // iOS and Android report `-1` for "no answer", and a -1 stored as a heading
    // draws an arrow on a technician standing in a kitchen.
    ...normaliseMotion({
      headingDegrees: location.coords.heading,
      speedMetersPerSecond: location.coords.speed,
    }),
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

  /**
   * "All the time" is asked for, and never required.
   *
   * It used to be required: without it this fell back to a watcher that stops
   * the moment the app leaves the screen. That is what almost every phone got,
   * because "while using the app" is the answer people give -- and on Android
   * 11 onward "all the time" is not even offered in the dialogue, only on a
   * settings page. So the office map showed technicians only while the app was
   * open at a property, and every drive between them was simply never recorded.
   *
   * Neither platform needs it to record in the background. Android lets a
   * foreground service started with the app on screen keep reading location
   * after it leaves, with its notification showing; iOS does the same for
   * updates started on screen with background updates allowed, with its blue
   * indicator showing. Both are exactly how this task runs.
   *
   * It is still worth having, and still asked for: with it, iOS relaunches a
   * recording the system ended, and Android can restart the service after the
   * system kills it. The app says so in Settings when it is missing.
   */
  await Location.requestBackgroundPermissionsAsync().catch(() => undefined);

  if (await startBackgroundUpdates()) return { started: true, mode: 'BACKGROUND' };

  // The task would not start at all -- Expo Go, or a binary without the
  // background mode. Recording while the app is open is still worth having.
  await watchInForeground();
  return { started: true, mode: 'FOREGROUND_ONLY' };
}

/**
 * Records while the app is on screen.
 *
 * `watchPositionAsync` rather than a registered task, for a build that cannot
 * run the task at all. This stops when the app leaves the foreground.
 */
async function watchInForeground() {
  if (foregroundWatch) return;

  /**
   * Only one recorder at a time.
   *
   * A background task registered in an earlier session outlives the app, so
   * reaching here -- the task refusing to start -- could leave an old one still
   * delivering while a foreground watch started alongside it. Both append to
   * the same queue, and production shows the result: two genuinely different
   * fixes, three to twenty-two metres apart, stamped with the same millisecond
   * and uploaded in one batch. The map drew two markers for one person.
   */
  await stopBackgroundUpdates();
  foregroundWatch = await Location.watchPositionAsync(
    {
      accuracy: FIX_ACCURACY,
      timeInterval: FIX_INTERVAL_MS,
      distanceInterval: FIX_DISTANCE_M,
    },
    (location) => {
      // Queued, then sent: the same path the background task uses, so a fix
      // recorded in either mode reaches the office the same way.
      void appendLocationFixes([toQueuedFix(location)]).then(() => sendRecordedFixes());
    },
  );
}

/** Whether the OS accepted the background task. */
async function startBackgroundUpdates(): Promise<boolean> {
  // The mirror of the guard in `watchInForeground`: a foreground watch left
  // running alongside the task is the same duplicate, arriving the other way
  // round.
  foregroundWatch?.remove();
  foregroundWatch = null;

  try {
    // Registered already -- by this launch, an earlier one, or an earlier
    // build. Brought up to date, and restarted if it has gone quiet, rather
    // than trusted: see `refreshBackgroundUpdates`.
    if (await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false)) {
      await refreshBackgroundUpdates();
      return true;
    }

    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, BACKGROUND_UPDATES);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long recording may go without a fix, with the app on screen, before it
 * is presumed stalled and restarted.
 *
 * A healthy recording standing still can go quiet too -- it reports on
 * movement -- so this is a restart, never a claim that anything failed. A
 * restart asks the OS for a position straight away, which is itself a fix.
 */
export const STALLED_AFTER_MS = 3 * 60_000;

/** The parts of the task's options that differ from build to build. */
function optionsKey(options: Partial<Location.LocationTaskOptions> | null | undefined) {
  return JSON.stringify([
    options?.accuracy ?? null,
    options?.timeInterval ?? null,
    options?.distanceInterval ?? null,
    options?.foregroundService?.notificationBody ?? null,
    options?.foregroundService?.killServiceOnDestroy ?? null,
  ]);
}

/**
 * Put a registered task right: this build's options, and delivering.
 *
 * **Neither platform can say whether a task is delivering.**
 * `hasStartedLocationUpdatesAsync` looks like that question and is not: on
 * Android it asks whether the task has a location consumer, on iOS whether it
 * is registered with one -- both true for a task the OS killed an hour ago. So
 * the recording that stopped for the rest of a working day kept reading as
 * running, and nothing restarted it. The last recorded fix is the evidence that
 * can be trusted.
 *
 * Also the only way a change of options reaches a running task: the OS stores
 * them with the registration, and nothing restarts a registered task, so an
 * earlier build's options would otherwise stay for good.
 *
 * - Registering again updates the options in place and restarts the updates,
 *   without touching the Android service.
 * - A change to the service itself -- its notification, whether it survives a
 *   swipe -- only reaches Android through a new service: stopped, then started.
 *
 * Only while the app is on screen: Android refuses to start a foreground
 * service from the background, and throws. Never throws itself.
 */
async function refreshBackgroundUpdates() {
  if (AppState.currentState !== 'active') return;
  try {
    const current = await TaskManager.getTaskOptionsAsync<Partial<Location.LocationTaskOptions>>(
      SHIFT_LOCATION_TASK,
    ).catch(() => null);
    const lastFixAt = await readLastFixAt();
    const stalled = lastFixAt === null || Date.now() - lastFixAt > STALLED_AFTER_MS;
    // Options that cannot be read say nothing about being out of date. Treating
    // them as different would stop and start the service -- notification and
    // all -- on every check, on a phone where nothing is wrong.
    const outdated = current !== null && optionsKey(current) !== optionsKey(BACKGROUND_UPDATES);
    if (!stalled && !outdated) return;

    const serviceChanged =
      outdated &&
      JSON.stringify(current?.foregroundService ?? null) !==
        JSON.stringify(BACKGROUND_UPDATES.foregroundService);
    if (serviceChanged)
      await Location.stopLocationUpdatesAsync(SHIFT_LOCATION_TASK).catch(() => undefined);
    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, BACKGROUND_UPDATES);
  } catch {
    // Left as it was. The next foreground, or the next check, tries again.
  }
}

export async function stopShiftTracking() {
  foregroundWatch?.remove();
  foregroundWatch = null;
  await stopBackgroundUpdates();
}

/**
 * Stops the registered task, if there is one.
 *
 * Guarded: stopping a task that was never started throws on Android, and this
 * is reached from sign-out, where the shift may never have begun.
 */
async function stopBackgroundUpdates() {
  if (!(await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false))) return;
  await Location.stopLocationUpdatesAsync(SHIFT_LOCATION_TASK).catch(() => undefined);
}

/** How this device is recording right now, for the office to see. */
export async function currentShiftMode(): Promise<ShiftMode | null> {
  if (foregroundWatch) return 'FOREGROUND_ONLY';
  return (await TaskManager.isTaskRegisteredAsync(SHIFT_LOCATION_TASK).catch(() => false))
    ? 'BACKGROUND'
    : null;
}

/**
 * Whether a shift is running, in either mode.
 *
 * Registered, which is all either platform can say -- see
 * `refreshBackgroundUpdates` for why that is not the same as delivering, and
 * what is done about it.
 */
export async function isShiftTrackingActive() {
  return (await currentShiftMode()) !== null;
}

/**
 * Put tracking back if it has stopped, and do nothing if it is healthy.
 *
 * Called whenever the app comes back to the foreground and on a timer while it
 * is there. Starts a shift that is not running; for one that is, restarts the
 * recording if nothing has been recorded for `STALLED_AFTER_MS`, or if its
 * options are out of date.
 */
export async function ensureShiftTracking(): Promise<ShiftStartResult | null> {
  // `startShiftTracking` re-checks permissions itself and reports the reason,
  // so this stays a thin wrapper rather than a second copy of that logic.
  if (!(await isShiftTrackingActive())) return startShiftTracking();
  if (!foregroundWatch) await refreshBackgroundUpdates();
  return null;
}
