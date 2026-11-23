import type { RefusedAsk } from '../utils/truck-stock';
import { demoStorage } from './demo-storage';

/**
 * Asks for more the server refused after the phone had kept them
 * (2026-11-24). An ask made with no signal is sent later, with nobody
 * watching; if the office then refuses it (the truck has five waiting, or the
 * technician was taken off it), the queue drops it. So the refusal is written
 * here with the server's reason, and My truck says it was not sent until the
 * technician has read it.
 */
const KEY = 'texasrenters-truck-ask-refusals-v1';
/** More than this and the oldest go. */
const MOST = 20;

const isRefusal = (value: unknown): value is RefusedAsk => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RefusedAsk>;
  return typeof row.clientRequestId === 'string' && typeof row.placeName === 'string' && typeof row.reason === 'string' && typeof row.at === 'string' && Array.isArray(row.named);
};

export async function readAskRefusals(): Promise<RefusedAsk[]> {
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

export async function noteAskRefusal(refusal: RefusedAsk): Promise<void> {
  const kept = (await readAskRefusals()).filter((row) => row.clientRequestId !== refusal.clientRequestId);
  await demoStorage.setItem(KEY, JSON.stringify([...kept, refusal].slice(-MOST)));
}

export async function dismissAskRefusal(clientRequestId: string): Promise<void> {
  const kept = (await readAskRefusals()).filter((row) => row.clientRequestId !== clientRequestId);
  if (kept.length) await demoStorage.setItem(KEY, JSON.stringify(kept));
  else await demoStorage.removeItem(KEY);
}
