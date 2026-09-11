import { normaliseMotion } from '@texasrenters/shared';

import { requestJson } from '../repositories/api/repositories';
import { deferFixes, fixesToSend, unsendableFixes } from './location-queue';
import { readLocationQueue, removeLocationFixes, writeLocationQueue } from './location-storage';

/**
 * Getting queued fixes to the API.
 *
 * Separate from the task that collects them, because the two run in different
 * worlds: collection happens in a headless `TaskManager` context that may have
 * no session and no network, while sending needs both. The queue is the seam.
 */
export async function drainLocationQueue(): Promise<{ sent: number; remaining: number }> {
  const queue = await readLocationQueue();
  if (!queue.length) return { sent: 0, remaining: 0 };

  // Fixes the API would refuse for a reason that will never change — a bad
  // clock, an impossible coordinate — are dropped here rather than retried for
  // ever in front of everything behind them.
  const doomed = unsendableFixes(queue);
  if (doomed.length) await removeLocationFixes(doomed.map((fix) => fix.id));

  const batch = fixesToSend(doomed.length ? await readLocationQueue() : queue);
  if (!batch.length) return { sent: 0, remaining: queue.length - doomed.length };

  try {
    await requestJson('/api/v1/technician/locations', {
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
    });
    await removeLocationFixes(batch.map((fix) => fix.id));
    const left = await readLocationQueue();
    return { sent: batch.length, remaining: left.length };
  } catch {
    // Kept and backed off, never dropped. A failure here is almost always a
    // property with no signal, and discarding the trail because the radio was
    // busy is the one outcome this queue exists to prevent.
    await writeLocationQueue(
      deferFixes(
        await readLocationQueue(),
        batch.map((fix) => fix.id),
      ),
    );
    const left = await readLocationQueue();
    return { sent: 0, remaining: left.length };
  }
}
