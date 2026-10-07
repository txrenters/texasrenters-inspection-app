import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { haversineMeters, normaliseMotion } from '@texasrenters/shared';
import { AppState, Platform } from 'react-native';

import { readPowerState } from '../lib/power-state';
import { cachedBatteryPercent, currentBatteryPercent } from './battery';
import { sendRecordedFixes } from './location-sender';
import { appendLocationFixes, readLastFixAt, readLastKeptFix, rememberKeptFix } from './location-storage';
import type { QueuedFix } from './location-queue';
import {
  advanceMotion,
  profileFor,
  STILL_UNKNOWN,
  type Motion,
  type TrackingProfile,
} from './tracking-profile';

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
 * Three seconds. A minute was fine for "which property is she at" and useless
 * for watching somebody move; fifteen was better and still drew a van
 * teleporting a quarter of a mile at a time down a road the console never
 * showed. The office asked to watch a technician drive -- speed, heading, where
 * they are now -- and at motorway speed three seconds is about fifty metres,
 * which reads as a vehicle following a road rather than hopping along it.
 *
 * **This is the Android number.** iOS ignores `timeInterval` and delivers on
 * `distanceInterval`, so an iPhone in a car has always reported roughly once a
 * second; what limited it there was how often the queue was drained, which is
 * `RECORDED_SEND_SPACING_MS`.
 *
 * `FIX_DISTANCE_M` is no longer given to the OS. It is the distance
 * `keepWorthwhile` thins by, which is the same rule applied one step later --
 * see `STATIONARY_HEARTBEAT_MS` for why it had to move.
 *
 * The cost is real and worth naming again: five times the fixes, at `High`
 * accuracy, on a phone that is also filming video. Google's own Driver SDK
 * reports every ten seconds by default and Fleet Engine expects five to sixty,
 * so three is dense by the standards of the industry that does this for a
 * living -- it is chosen for a handful of vans, not a fleet, and it is the
 * first line to change if a technician's battery does not last the shift.
 */
const FIX_INTERVAL_MS = 3_000;
const FIX_DISTANCE_M = 10;

/**
 * How long a standing technician may go unrecorded.
 *
 * `distanceInterval` used to carry this rule, and it cannot: it is a filter on
 * *movement*, so a phone that does not move produces nothing at all. On iOS
 * that is the only gate there is, because `timeInterval` is ignored. A
 * technician who parks, walks in and works for forty minutes recorded not one
 * fix, and the trail showed them arriving and then simply ceasing to exist.
 *
 * Measured on 2026-09-23 against a month of real work: of 37 jobs replayed,
 * **7 had no fix within 100 metres of the property at all** -- closest
 * approaches of 500 m, 600 m, 2 km, 3.2 km -- for visits the technician had
 * demonstrably attended. Nothing downstream can bill time from a trail with
 * the middle of every visit missing.
 *
 * So the OS filter is off and this thins instead, which is the same rule plus
 * a floor: keep a fix that moved, and keep one every half minute regardless.
 * Half a minute because the time tracker needs several fixes inside a
 * ninety-second dwell to call an arrival, and three is enough to outvote one
 * bad one.
 */
const STATIONARY_HEARTBEAT_MS = 30_000;

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
  /**
   * No movement filter. The thinning happens in the task instead.
   *
   * This was `FIX_DISTANCE_M`, and a filter on distance cannot express "and
   * also tell me every half minute when they are standing still" -- which is
   * exactly the case a time tracker is built to measure. See
   * `STATIONARY_HEARTBEAT_MS`.
   *
   * The battery cost is smaller than it looks: the receiver is already running
   * at `High` for the interval above, and this only stops the OS discarding
   * what it has already computed. It does mean the task is woken more often,
   * so the thinning below keeps what reaches the queue and the wire at very
   * nearly what it was before -- a moving technician produces exactly the same
   * fixes as it always did.
   */
  distanceInterval: 0,
  /**
   * Tell iOS this is a vehicle following a road.
   *
   * It was not set, so iOS assumed `Other` and treated a technician on the
   * motorway like an app that happened to want a location -- free to suspend
   * between fixes. `AutomotiveNavigation` is the class iOS gives turn-by-turn
   * apps: it keeps delivering while the vehicle moves and tunes its own
   * filtering for road speed.
   *
   * On 2026-09-21 a fifty-kilometre drive between 16:16 and 17:47 produced not
   * one fix, while shorter gaps that day were two to six minutes -- the length
   * the stall-restart bounds them to. Ninety-one minutes is not that
   * mechanism failing to recover; it is the OS never delivering in the first
   * place. This is the option that speaks to that.
   *
   * Android ignores it, and `pausesUpdatesAutomatically: false` below still
   * overrides the auto-pause this activity type would otherwise invite.
   */
  activityType: Location.ActivityType.AutomotiveNavigation,
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

/**
 * The rate on site, and in Low Power Mode (the office, 2026-10-06). See
 * `tracking-profile` for when it applies and why the accuracy stays.
 *
 * Half a minute on Android. iOS ignores the interval and delivers on distance,
 * so there it is a fix per 25 m moved: a technician working through a house
 * wakes the app a handful of times instead of once a second, and the moment they
 * drive off the fixes come back at road speed. A phone that stays put is then
 * silent, which the timesheet already reads as still there ("a quiet phone does
 * not stop the clock").
 */
const SETTLED_UPDATES: Location.LocationTaskOptions = {
  ...BACKGROUND_UPDATES,
  timeInterval: 30_000,
  distanceInterval: Platform.OS === 'ios' ? 25 : 0,
};

/** The task's options for a profile. `BACKGROUND_UPDATES` is the moving one. */
export function optionsFor(profile: TrackingProfile): Location.LocationTaskOptions {
  return profile === 'SETTLED' ? SETTLED_UPDATES : BACKGROUND_UPDATES;
}

/**
 * The profile the task is running with, and the motion that decides the next.
 *
 * Module state, held by the process the task runs in. A process the OS starts
 * afresh begins at `MOVING` -- the dense rate, never the sparse one -- and
 * settles again five minutes later if the technician has not moved.
 */
let activeProfile: TrackingProfile = 'MOVING';
let motion: Motion = STILL_UNKNOWN;

/** How old a fix may be and still say anything about moving or standing now. */
const MOTION_MAX_AGE_MS = 15 * 60_000;

/**
 * Follows what the technician is doing: moving, settled, or saving power.
 *
 * From inside the task, so it works with the phone in a pocket. Re-registering
 * a running task only restarts its location updates: on Android the foreground
 * service is left as it is (expo-location starts one only when none is
 * running), so this is safe from the background where starting one is not.
 */
async function followMotion(delivered: readonly QueuedFix[]) {
  const now = Date.now();
  for (const fix of delivered) {
    const at = Date.parse(fix.recordedAt);
    // Only what is current. A backlog delivered after an outage says where the
    // technician was, not whether they are standing still now.
    if (Number.isFinite(at) && now - at < MOTION_MAX_AGE_MS)
      motion = advanceMotion(motion, {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyMeters: fix.accuracyMeters ?? null,
        at,
      });
  }
  const { lowPower } = await readPowerState();
  const wanted = profileFor({ motion, lowPower, now });
  if (wanted === activeProfile) return;
  const previous = activeProfile;
  activeProfile = wanted;
  try {
    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, optionsFor(wanted));
  } catch {
    // Not applied: try again on the next batch.
    activeProfile = previous;
  }
}

/**
 * Which of the delivered fixes are worth keeping.
 *
 * The rule the OS used to apply, plus the floor it could not: a fix is kept
 * when it is `FIX_DISTANCE_M` from the last one kept, **or** when
 * `STATIONARY_HEARTBEAT_MS` has passed since that one. A moving technician
 * therefore produces exactly what they always did -- the distance test is the
 * same test, against the same distance -- and a standing one now produces two
 * fixes a minute instead of none.
 *
 * Compared against the last *kept* fix rather than the previous delivered one,
 * or a slow walk would be thinned away a metre at a time.
 */
export async function keepWorthwhile(delivered: readonly QueuedFix[]): Promise<QueuedFix[]> {
  if (!delivered.length) return [];
  let last = await readLastKeptFix();
  const kept: QueuedFix[] = [];

  for (const fix of delivered) {
    const at = Date.parse(fix.recordedAt);
    if (!Number.isFinite(at)) continue;
    if (last) {
      const moved = haversineMeters(
        { latitude: last.latitude, longitude: last.longitude },
        { latitude: fix.latitude, longitude: fix.longitude },
      );
      if (moved < FIX_DISTANCE_M && at - last.at < STATIONARY_HEARTBEAT_MS) continue;
    }
    kept.push(fix);
    last = { latitude: fix.latitude, longitude: fix.longitude, at };
  }

  // Written only when something was kept. It was written on every delivery --
  // once a second on an iPhone in a car -- with the same value it already held.
  if (last && kept.length) await rememberKeptFix(last);
  return kept;
}

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

  // At most once a minute, not once per batch: batches come once a second on
  // an iPhone in a car, and the charge cannot have moved between two of them.
  // Null when the phone will not say, which is a different fact from "nearly
  // flat".
  const batteryPercent = await cachedBatteryPercent();

  // The device's own clock at the moment of each fix. The API keeps that
  // separately from when it heard about it, so a batch delivered after an
  // outage still draws the route in the order it was walked.
  const delivered: QueuedFix[] = locations.map((location) => toQueuedFix(location, batteryPercent));
  await followMotion(delivered);
  const fixes = await keepWorthwhile(delivered);
  if (!fixes.length) return;

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
function toQueuedFix(
  location: Location.LocationObject,
  /**
   * The charge at the moment the batch was delivered.
   *
   * Passed in rather than read here, because reading it is asynchronous and
   * this is called from a `map`. Null means nobody knows -- a simulator, or a
   * platform that will not answer -- and never "flat".
   */
  batteryPercent: number | null = null,
): QueuedFix {
  return {
    id: fixId(),
    batteryPercent,
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
      // recorded in either mode reaches the office the same way -- including
      // the charge, which is read per fix here because a foreground watch
      // delivers one at a time rather than in batches.
      void currentBatteryPercent()
        .then((batteryPercent) => appendLocationFixes([toQueuedFix(location, batteryPercent)]))
        .then(() => sendRecordedFixes());
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

    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, optionsFor(activeProfile));
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

/**
 * The same, settled. An iPhone settled in a house reports per 25 m moved, so
 * minutes of quiet are the recording working; restarting it every check would
 * spend the battery this profile exists to save.
 */
export const SETTLED_STALLED_AFTER_MS = 20 * 60_000;

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
    const wanted = optionsFor(activeProfile);
    const lastFixAt = await readLastFixAt();
    const stalledAfter = activeProfile === 'SETTLED' ? SETTLED_STALLED_AFTER_MS : STALLED_AFTER_MS;
    const stalled = lastFixAt === null || Date.now() - lastFixAt > stalledAfter;
    // Options that cannot be read say nothing about being out of date. Treating
    // them as different would stop and start the service -- notification and
    // all -- on every check, on a phone where nothing is wrong.
    const outdated = current !== null && optionsKey(current) !== optionsKey(wanted);
    if (!stalled && !outdated) return;

    const serviceChanged =
      outdated &&
      JSON.stringify(current?.foregroundService ?? null) !== JSON.stringify(wanted.foregroundService);
    if (serviceChanged)
      await Location.stopLocationUpdatesAsync(SHIFT_LOCATION_TASK).catch(() => undefined);
    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, wanted);
  } catch {
    // Left as it was. The next foreground, or the next check, tries again.
  }
}

export async function stopShiftTracking() {
  foregroundWatch?.remove();
  foregroundWatch = null;
  // The next shift starts dense, and settles on its own evidence.
  activeProfile = 'MOVING';
  motion = STILL_UNKNOWN;
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
