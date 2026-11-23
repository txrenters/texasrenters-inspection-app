import type { PhoneCounts, SavePhoneCountResult } from '@texasrenters/shared';

import { dismissCountRefusal, readCountRefusals } from '../../storage/count-refusals';
import { cachedApiRecord, storeApiRecord } from '../../storage/offline-record-cache';
import type { PendingCount, RefusedCount } from '../../utils/truck-count';
import type { CountRepository } from '../contracts';
import { TRUCK_COUNT_KIND, savedTruckCount, sendSavedFirst, truckCountEntryId } from './offline-writes';
import { requestJson } from './repositories';
import { truckCountSavedSchema, truckCountsSchema } from './truck-counts-schema';

const LIST = '/api/v1/technician/stock-counts';
const path = (countId: string) => `${LIST}/${encodeURIComponent(countId)}`;
const RECORD = 'truck-counts';

/**
 * Counting a truck from the phone (2026-11-19). There is no technician and no
 * truck in these paths or bodies: the server reads who is asking from the
 * session, and decides which counts are theirs to count.
 *
 * Reading keeps a copy, so the count's lines show with no signal. Saving is
 * written to the phone before it is sent (`sendSavedFirst`): a number typed
 * in a basement, or as the app is closed, is still there at the next launch.
 * Its replay is harmless: each line says whether it is the first or the
 * second count of that line, and the server writes nothing for a send that no
 * longer matches.
 */
export class ApiCountRepository implements CountRepository {
  async mine(): Promise<PhoneCounts> {
    return cachedApiRecord(RECORD, truckCountsSchema, () => requestJson(LIST));
  }

  async save(count: PendingCount): Promise<SavePhoneCountResult> {
    const { countId, lines, handIn, found } = count;
    // What was found and not listed goes with the lines (2026-11-24).
    const body = { lines, handIn, ...(found?.length ? { found } : {}) };
    const reply = await sendSavedFirst({ id: truckCountEntryId(countId), kind: TRUCK_COUNT_KIND, payload: { ...count } }, () => requestJson(path(countId), { method: 'POST', body: JSON.stringify(body) }));
    const saved = truckCountSavedSchema.parse(reply);
    // The list as it now is, kept for when there is no signal: a count handed in has left it.
    await storeApiRecord(RECORD, truckCountsSchema, { counts: saved.counts, catalog: saved.catalog });
    return saved;
  }

  pending(countId: string): Promise<PendingCount | null> {
    return savedTruckCount(countId);
  }

  refused(): Promise<RefusedCount[]> {
    return readCountRefusals();
  }

  dismissRefusal(countId: string): Promise<void> {
    return dismissCountRefusal(countId);
  }
}
