import * as Location from 'expo-location';
import { normaliseNavFix, type NavFix, type RawFix } from '@texasrenters/shared';

/**
 * Where navigation gets its positions, without becoming a second recorder.
 *
 * ## The fault this module is shaped around
 *
 * `shift-tracking.ts` already runs exactly one `expo-location` consumer -- a
 * registered TaskManager task, or a foreground watch when the task cannot
 * start. It has a comment describing what happened the last time there were
 * two: "two genuinely different fixes, three to twenty-two metres apart,
 * stamped with the same millisecond and uploaded in one batch. The map drew two
 * markers for one person."
 *
 * Read it closely and the fault is not the second *watcher*. It is the second
 * **writer**: both consumers called `appendLocationFixes`, so the office queue
 * received each position twice and the console drew both. Navigation subscribes
 * and never writes -- nothing in this directory imports `location-storage`,
 * `location-queue` or `location-sender`, and nothing in it can put a point on
 * the office map.
 *
 * ## Why this cannot make `currentShiftMode()` lie
 *
 * `currentShiftMode()` reports `FOREGROUND_ONLY` the moment shift-tracking's
 * module-level `foregroundWatch` is non-null -- which would tell the office
 * that a phone had stopped recording in the background when it had not.
 *
 * That variable is a module-private `let` in `shift-tracking.ts` with no
 * exported setter, and the only three assignments to it are in
 * `watchInForeground`, `startBackgroundUpdates` and `stopShiftTracking`. A
 * subscription created here is held in *this* module's scope and is invisible
 * to it. Nothing here calls `startLocationUpdatesAsync` or
 * `stopLocationUpdatesAsync` either, so the registered task -- the other half
 * of that answer -- is untouched. `currentShiftMode()` reads exactly what it
 * read before.
 *
 * ## The one-line change that makes the fallback unnecessary
 *
 * The right long-term shape is for the existing recorder to publish, so there
 * is one consumer of the GPS on the handset. That needs a single line inside
 * the `locations.map` in shift-tracking's `defineTask`, and in the
 * `watchPositionAsync` callback beside it:
 *
 * ```ts
 * publishNavFix({ ...location.coords, timestamp: location.timestamp });
 * ```
 *
 * That file is out of scope for this change and has not been touched. Until it
 * lands, `subscribeToNavFixes` starts its own read-only watch -- and the moment
 * a publisher appears, it stands down on its own (see `PUBLISHER_QUIET_MS`), so
 * the two never run together and nothing has to be removed from here.
 */

type NavFixListener = (fix: NavFix) => void;

/**
 * How long a publisher is believed to still be publishing.
 *
 * The recorder asks for a fix every three seconds or every ten metres, and a
 * parked phone earns neither -- so silence is not evidence that publishing has
 * stopped. Twenty seconds is long enough to cover a stationary van and short
 * enough that navigation is not left blind if the shift genuinely ends.
 */
const PUBLISHER_QUIET_MS = 20_000;

/**
 * What the fallback watch asks for.
 *
 * `High`, not `BestForNavigation`, and for the same reason `shift-tracking.ts`
 * gives: on iOS the navigation class adds sensor fusion this does not need, on
 * a phone that is also filming video. Two seconds and five metres is tighter
 * than the recorder's three and ten, because a turn arrives in under a second
 * at surface-street speed -- but it is a *ceiling*, and a stationary phone
 * still produces nothing, which is why the session is also ticked by the clock.
 */
const FALLBACK_WATCH: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  timeInterval: 2_000,
  distanceInterval: 5,
};

/** A last-known fix older than this is history, not a position. */
const LAST_KNOWN_MAX_AGE_MS = 60_000;

const listeners = new Set<NavFixListener>();
let latest: NavFix | null = null;
let publishedAt = Number.NEGATIVE_INFINITY;
let fallbackWatch: Location.LocationSubscription | null = null;
let startingFallback: Promise<void> | null = null;

/**
 * The entry point for the existing recorder. See the module note.
 *
 * Every fix that reaches navigation goes through `normaliseNavFix`, here and in
 * the fallback below, because the `-1` trap is not a server-side tidy-up: both
 * platforms report `-1` for "no course" and "no speed" on the handset, and a
 * raw `-1` speed reads as stationary while the van is doing seventy -- which
 * would satisfy the arrival speed test at the wrong house.
 */
export function publishNavFix(raw: RawFix, now = Date.now()): void {
  publishedAt = now;

  // A publisher has appeared, so the fallback is no longer needed. Stopping it
  // here rather than waiting for the next subscription means the two never
  // overlap for more than the fix that revealed it.
  stopFallbackWatch();

  emit(normaliseNavFix(raw, now));
}

/**
 * Listen for positions. Returns the unsubscribe.
 *
 * Starting the fallback is deliberately not awaited: navigation must draw the
 * road the moment it is asked to, with the last known position if that is all
 * there is, rather than waiting on a permissions round-trip.
 */
export function subscribeToNavFixes(listener: NavFixListener): () => void {
  listeners.add(listener);
  if (latest) listener(latest);

  void ensureFallbackWatch();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopFallbackWatch();
  };
}

/** The most recent fix, for a screen opening mid-drive. */
export function latestNavFix(): NavFix | null {
  return latest;
}

/** Whether the existing recorder is feeding this bus. For the diagnostics screen. */
export function navFixesArePublished(now = Date.now()): boolean {
  return now - publishedAt < PUBLISHER_QUIET_MS;
}

/** Test seam: forget every listener, the last fix, and any watch. */
export function resetNavFixes(): void {
  listeners.clear();
  latest = null;
  publishedAt = Number.NEGATIVE_INFINITY;
  stopFallbackWatch();
  startingFallback = null;
}

function emit(fix: NavFix): void {
  latest = fix;
  for (const listener of [...listeners]) {
    try {
      listener(fix);
    } catch {
      // One screen throwing must not stop the fix reaching the others, and must
      // never take down the watch that is feeding them.
    }
  }
}

async function ensureFallbackWatch(): Promise<void> {
  if (fallbackWatch || startingFallback || listeners.size === 0) return;
  if (navFixesArePublished()) return;

  startingFallback = beginFallbackWatch().finally(() => {
    startingFallback = null;
  });
  await startingFallback;
}

async function beginFallbackWatch(): Promise<void> {
  try {
    /**
     * Asked, never requested.
     *
     * The permission conversation belongs to `ShiftAutoStart`, which explains
     * why the app wants location and puts the switch back when it is refused.
     * A second prompt raised from a navigation screen would arrive with no
     * explanation and, on iOS, would spend the one chance the app gets.
     */
    const permission = await Location.getForegroundPermissionsAsync().catch(() => null);
    if (!permission?.granted) return;

    // Something to draw with immediately. A cached fix is usually seconds old
    // and is the difference between a map that opens on the technician and one
    // that opens on the Gulf of Mexico while it waits for a satellite.
    const known = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
    }).catch(() => null);
    if (known && listeners.size > 0 && !latest) emit(fixFrom(known));

    if (listeners.size === 0 || navFixesArePublished()) return;

    fallbackWatch = await Location.watchPositionAsync(FALLBACK_WATCH, (location) => {
      emit(fixFrom(location));
    });

    // Both races the await above can lose: the last subscriber leaving while
    // the watch was starting, or the recorder starting to publish. Either way
    // the watch that just started is the wrong one to keep.
    if (listeners.size === 0 || navFixesArePublished()) stopFallbackWatch();
  } catch {
    // No location on this build, or services switched off. Navigation shows
    // that it is waiting for a position; there is nothing to retry here,
    // because the next subscription tries again.
  }
}

function stopFallbackWatch(): void {
  fallbackWatch?.remove();
  fallbackWatch = null;
}

function fixFrom(location: Location.LocationObject): NavFix {
  return normaliseNavFix(
    {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,
      heading: location.coords.heading,
      timestamp: location.timestamp,
    },
    Date.now(),
  );
}
