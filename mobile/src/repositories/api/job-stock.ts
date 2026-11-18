import type { JobStock } from '@texasrenters/shared';

import { cachedApiRecord, storeApiRecord } from '../../storage/offline-record-cache';
import { dismissStockRefusal, readStockRefusals } from '../../storage/stock-refusals';
import type { PendingSlip, RefusedSlip } from '../../utils/job-stock';
import type { StockRepository } from '../contracts';
import { jobStockSchema } from './job-stock-schema';
import { JOB_STOCK_KIND, jobStockEntryId, savedJobStockSlips, sendSavedFirst } from './offline-writes';
import { requestJson } from './repositories';

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
    const { inspectionId, kind, placeId, lines, clientRequestId } = slip;
    const reply = await sendSavedFirst({ id: jobStockEntryId(clientRequestId), kind: JOB_STOCK_KIND, payload: { ...slip } }, () =>
      requestJson(path(inspectionId), { method: 'POST', body: JSON.stringify({ kind, placeId, lines, clientRequestId }) }),
    );
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
}
