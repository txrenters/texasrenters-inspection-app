import type { RefusedSlip } from '../utils/job-stock';
import { demoStorage } from './demo-storage';

/**
 * Slips the server refused after the phone had kept them (2026-11-19).
 *
 * A withdrawal recorded with no signal is sent later, with nobody watching.
 * If the office's numbers then say there was not enough in the truck, the
 * queue drops it -- and for stock that is a record lost without a word. So
 * the refusal is written here with the server's reason, and the job's
 * Materials screen says it was not recorded until the technician has read it.
 */
const KEY = 'texasrenters-stock-refusals-v1';
/** More than this and the oldest go: a phone is not a ledger. */
const MOST = 40;

const isRefusal = (value: unknown): value is RefusedSlip => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RefusedSlip>;
  return typeof row.clientRequestId === 'string' && typeof row.inspectionId === 'string' && typeof row.reason === 'string' && typeof row.at === 'string' && Array.isArray(row.named) && (row.kind === 'WITHDRAWAL' || row.kind === 'RETURN');
};

export async function readStockRefusals(): Promise<RefusedSlip[]> {
  const stored = await demoStorage.getItem(KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isRefusal) : [];
  } catch {
    await demoStorage.removeItem(KEY);
    return [];
  }
}

export async function noteStockRefusal(refusal: RefusedSlip): Promise<void> {
  const kept = (await readStockRefusals()).filter((row) => row.clientRequestId !== refusal.clientRequestId);
  await demoStorage.setItem(KEY, JSON.stringify([...kept, refusal].slice(-MOST)));
}

export async function dismissStockRefusal(clientRequestId: string): Promise<void> {
  const kept = (await readStockRefusals()).filter((row) => row.clientRequestId !== clientRequestId);
  if (kept.length) await demoStorage.setItem(KEY, JSON.stringify(kept));
  else await demoStorage.removeItem(KEY);
}
