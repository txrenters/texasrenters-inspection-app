import type { RefusedCount } from '../utils/truck-count';
import { demoStorage } from './demo-storage';

/**
 * Truck counts the server refused after the phone had kept them (2026-11-19).
 *
 * A count typed with no signal is sent later, with nobody watching. If by
 * then the office has cancelled the count, or given the truck to somebody
 * else, the queue drops it. So the refusal is written here with the server's
 * reason, and the home screen says the count was not taken until the
 * technician has read it.
 */
const KEY = 'texasrenters-count-refusals-v1';
/** More than this and the oldest go: a phone is not a ledger. */
const MOST = 20;

const isRefusal = (value: unknown): value is RefusedCount => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RefusedCount>;
  return typeof row.countId === 'string' && typeof row.title === 'string' && typeof row.reason === 'string' && typeof row.at === 'string';
};

export async function readCountRefusals(): Promise<RefusedCount[]> {
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

export async function noteCountRefusal(refusal: RefusedCount): Promise<void> {
  const kept = (await readCountRefusals()).filter((row) => row.countId !== refusal.countId);
  await demoStorage.setItem(KEY, JSON.stringify([...kept, refusal].slice(-MOST)));
}

export async function dismissCountRefusal(countId: string): Promise<void> {
  const kept = (await readCountRefusals()).filter((row) => row.countId !== countId);
  if (kept.length) await demoStorage.setItem(KEY, JSON.stringify(kept));
  else await demoStorage.removeItem(KEY);
}
