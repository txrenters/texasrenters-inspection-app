import { normaliseMotion } from '@texasrenters/shared';
import { AppState, Platform } from 'react-native';

import { getSession } from '../auth/session';
import { requestJson } from '../repositories/api/repositories';
import { deferFixes, fixesToSend, unsendableFixes } from './location-queue';
import { readLocationQueue, removeLocationFixes, updateLocationQueue } from './location-storage';

/**
 * Getting queued fixes to the API.
 *
 * Separate from the task that collects them. The queue is the seam: a fix is
 * written there first, so nothing recorded is lost when a send fails, and sent
 * from there by whichever of two callers gets to it -- the location task, as
 * each fix is recorded, and `LocationShiftRunner`, on a timer while the app is
 * open.
 *
 * **Sending used to be the timer's alone, and that is why the office map froze
 * whenever a technician drove.** Android pauses JavaScript timers the moment an
 * app leaves the screen. The location task kept recording the whole drive --
 * the foreground service keeps it alive -- but nothing sent a single point
 * until the technician opened the app at the next property, when the entire
 * drive arrived in one batch. From the console the marker sat still for the
 * length of every drive and jumped at every address.
 */

export interface DrainResult {
  sent: number;
  remaining: number;
}

/**
 * How long one send may run before another may start regardless.
 *
 * Only one runs at a time, and that guard must not become a way to stop sending
 * for good. The fifteen-second abort inside `requestJson` is a timer, and
 * Android does not run timers in the background -- so a request that hangs in
 * a dead zone would otherwise hold every later fix on the handset until the app
 * was opened. Measured by comparing clocks when the next fix arrives, which
 * needs no timer.
 */
const ABANDON_SEND_AFTER_MS = 60_000;

/**
 * The least time between two sends started by recorded fixes.
 *
 * iOS ignores the fix interval and reports every ten metres, which in a car is
 * more than once a second. Sending per fix would be a request a second; this
 * keeps a moving technician to one every ten seconds, which is as live as the
 * console needs.
 */
const RECORDED_SEND_SPACING_MS = 10_000;

let flight: { promise: Promise<DrainResult>; startedAt: number } | null = null;
let lastSendStartedAt = Number.NEGATIVE_INFINITY;

/**
 * Send the next batch, unless one is already on its way.
 *
 * One at a time: two sends overlapping would post the same fixes twice. The
 * server would discard the second copy by `deviceFixId`, but it is a request
 * spent on nothing, from a handset short of signal.
 */
export function drainLocationQueue(now = Date.now()): Promise<DrainResult> {
  if (flight && now - flight.startedAt < ABANDON_SEND_AFTER_MS) return flight.promise;

  lastSendStartedAt = now;
  const promise: Promise<DrainResult> = sendNextBatch().finally(() => {
    if (flight?.promise === promise) flight = null;
  });
  flight = { promise, startedAt: now };
  return promise;
}

/**
 * Called as each fix is recorded: send it now, spaced as above.
 *
 * Never throws. This runs inside the location task, and a task that throws is
 * a location service in trouble; a send that fails has already left its fixes
 * queued for the next attempt.
 */
export async function sendRecordedFixes(now = Date.now()): Promise<void> {
  if (now - lastSendStartedAt < RECORDED_SEND_SPACING_MS) return;
  await drainLocationQueue(now).catch(() => undefined);
}

/** Test seam: forget any send in flight and when the last one began. */
export function resetLocationSender() {
  flight = null;
  lastSendStartedAt = Number.NEGATIVE_INFINITY;
}

/**
 * Whether this send may renew the session if the token is about to expire.
 *
 * Renewing rotates the refresh token: the server retires the old one as it
 * issues the new, and reads the old one being offered again as theft, ending
 * every session on the account. So a renewal whose new token cannot be saved
 * signs the technician out at the next attempt.
 *
 * That is an iPhone in a pocket. The session lives in the keychain, which iOS
 * locks shortly after the screen, and sends now happen while the phone is
 * locked. An app is only ever `active` on an unlocked phone, so that is when
 * iOS may renew. Android's keystore stays usable while the screen is locked, so
 * it always may.
 *
 * A send that may not renew uses the token while it is still good and, when it
 * is not, leaves the fixes queued for the app to send -- and renew -- the next
 * time it is on screen, which is what happened to every fix before this.
 */
export function maySessionRenewNow() {
  return Platform.OS !== 'ios' || AppState.currentState === 'active';
}

async function sendNextBatch(): Promise<DrainResult> {
  const queue = await readLocationQueue();
  if (!queue.length) return { sent: 0, remaining: 0 };

  // Fixes the API would refuse for a reason that will never change — a bad
  // clock, an impossible coordinate — are dropped here rather than retried for
  // ever in front of everything behind them.
  const doomed = unsendableFixes(queue);
  if (doomed.length) await removeLocationFixes(doomed.map((fix) => fix.id));

  const batch = fixesToSend(doomed.length ? await readLocationQueue() : queue);
  if (!batch.length) return { sent: 0, remaining: queue.length - doomed.length };

  // Asked before the request rather than left to fail inside it. No usable
  // session is not a failed send: backing these fixes off would hold them
  // behind a retry delay even after the app opens and could send them at once.
  const renewSession = maySessionRenewNow();
  const session = await getSession({ renew: renewSession }).catch(() => null);
  if (!session) return { sent: 0, remaining: queue.length - doomed.length };

  try {
    await requestJson(
      '/api/v1/technician/locations',
      {
        method: 'POST',
        body: JSON.stringify({
          fixes: batch.map((fix) => {
            // Omitted rather than sent as null: the DTO marks them `@IsOptional`,
            // and a queue written by an older build has neither key at all.
            const motion = normaliseMotion(fix);
            return {
              // The queue's own id, which is what makes a retry idempotent. It
              // has always existed and never left the device.
              deviceFixId: fix.id,
              latitude: fix.latitude,
              longitude: fix.longitude,
              recordedAt: fix.recordedAt,
              ...(fix.accuracyMeters === null || fix.accuracyMeters === undefined
                ? {}
                : { accuracyMeters: fix.accuracyMeters }),
              ...(fix.batteryPercent === null || fix.batteryPercent === undefined
                ? {}
                : { batteryPercent: fix.batteryPercent }),
              ...(motion.headingDegrees === null ? {} : { headingDegrees: motion.headingDegrees }),
              ...(motion.speedMetersPerSecond === null
                ? {}
                : { speedMetersPerSecond: motion.speedMetersPerSecond }),
            };
          }),
        }),
      },
      { renewSession },
    );
    await removeLocationFixes(batch.map((fix) => fix.id));
    const left = await readLocationQueue();
    return { sent: batch.length, remaining: left.length };
  } catch {
    // Kept and backed off, never dropped. A failure here is almost always a
    // property with no signal, and discarding the trail because the radio was
    // busy is the one outcome this queue exists to prevent.
    const tried = batch.map((fix) => fix.id);
    await updateLocationQueue((current) => deferFixes(current, tried));
    const left = await readLocationQueue();
    return { sent: 0, remaining: left.length };
  }
}
