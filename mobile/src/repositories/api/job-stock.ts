import type { JobStock, MyTrucks, PhoneCatalogItem } from '@texasrenters/shared';

import { cachedApiRecord, storeApiRecord } from '../../storage/offline-record-cache';
import { dismissStockRefusal, noteStockRefusal, readStockRefusals } from '../../storage/stock-refusals';
import { dismissAskRefusal, readAskRefusals } from '../../storage/truck-ask-refusals';
import type { PendingSlip, RefusedSlip } from '../../utils/job-stock';
import type { PendingAsk, RefusedAsk } from '../../utils/truck-stock';
import type { StockRepository } from '../contracts';
import { jobStockSchema } from './job-stock-schema';
import { myTrucksSchema } from './my-truck-schema';
import { JOB_STOCK_KIND, QueuedOfflineError, TRUCK_ASK_KIND, jobStockEntryId, savedJobStockSlips, savedTruckAsks, sendSavedFirst, truckAskEntryId } from './offline-writes';
import { requestJson } from './repositories';

const MY_TRUCKS = '/api/v1/technician/truck';
const MY_TRUCKS_RECORD = 'my-trucks';

const path = (inspectionId: string) => `/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/stock`;
const recordKey = (inspectionId: string) => `job-stock:${inspectionId}`;

/**
 * A job's materials (2026-11-19, phase 7). There is no technician and no truck
 * owner anywhere in these paths or bodies: the server reads who is asking from
 * the session, and decides which truck they may use.
 *
 * Reading keeps a copy, so the truck's contents show with no signal. Recording
 * is saved on the phone before it is sent (`sendSavedFirst`): a slip recorded
 * in a basement, or as the app is closed, is still there at the next launch.
 * Its replay is harmless -- the slip carries its own key, and the server
 * records a key once.
 */
export class ApiStockRepository implements StockRepository {
  async forJob(inspectionId: string): Promise<JobStock> {
    return cachedApiRecord(recordKey(inspectionId), jobStockSchema, () => requestJson(path(inspectionId)));
  }

  async record(slip: PendingSlip): Promise<JobStock> {
    const { inspectionId, kind, placeId, lines, clientRequestId, named } = slip;
    let reply: unknown;
    try {
      reply = await sendSavedFirst({ id: jobStockEntryId(clientRequestId), kind: JOB_STOCK_KIND, payload: { ...slip } }, () =>
        requestJson(path(inspectionId), { method: 'POST', body: JSON.stringify({ kind, placeId, lines, clientRequestId }) }),
      );
    } catch (error) {
      /**
       * Refused while the technician was watching (2026-11-24). The phone has
       * let the slip go, and it was said only in a line under the button, with
       * the amounts already cleared -- gone once they left the screen. Written
       * down like a refusal that comes back later, so the job's list says "Not
       * recorded" and what, until they have read it. Kept for sending later is
       * not a refusal.
       */
      if (!(error instanceof QueuedOfflineError))
        await noteStockRefusal({
          clientRequestId,
          inspectionId,
          kind,
          named,
          reason: error instanceof Error && error.message ? error.message : 'The office could not record it.',
          at: new Date().toISOString(),
        });
      throw error;
    }
    return storeApiRecord(recordKey(inspectionId), jobStockSchema, reply);
  }

  pending(inspectionId: string): Promise<PendingSlip[]> {
    return savedJobStockSlips(inspectionId);
  }

  async refused(inspectionId: string): Promise<RefusedSlip[]> {
    return (await readStockRefusals()).filter((row) => row.inspectionId === inspectionId);
  }

  dismissRefusal(clientRequestId: string): Promise<void> {
    return dismissStockRefusal(clientRequestId);
  }

  /** My truck (2026-11-24): read with a copy kept, so the truck shows with no signal once it has been read. */
  async myTrucks(): Promise<MyTrucks> {
    return cachedApiRecord(MY_TRUCKS_RECORD, myTrucksSchema, () => requestJson(MY_TRUCKS));
  }

  async catalog(): Promise<PhoneCatalogItem[]> {
    return (await this.myTrucks()).catalog;
  }

  /** An ask is saved on the phone before it is sent, like a slip: one made in a basement goes when there is signal. */
  async ask(ask: PendingAsk): Promise<MyTrucks> {
    const { placeId, lines, note, clientRequestId } = ask;
    const reply = await sendSavedFirst({ id: truckAskEntryId(clientRequestId), kind: TRUCK_ASK_KIND, payload: { ...ask } }, () =>
      requestJson(`${MY_TRUCKS}/asks`, { method: 'POST', body: JSON.stringify({ placeId, lines, note, clientRequestId }) }),
    );
    return storeApiRecord(MY_TRUCKS_RECORD, myTrucksSchema, reply);
  }

  pendingAsks(): Promise<PendingAsk[]> {
    return savedTruckAsks();
  }

  refusedAsks(): Promise<RefusedAsk[]> {
    return readAskRefusals();
  }

  dismissAskRefusal(clientRequestId: string): Promise<void> {
    return dismissAskRefusal(clientRequestId);
  }

  refusedSlips(): Promise<RefusedSlip[]> {
    return readStockRefusals();
  }
}
