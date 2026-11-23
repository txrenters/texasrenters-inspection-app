import { normalizeStockCode, type JobStockItem, type PhoneCatalogItem, type PhoneSlipKind } from '@texasrenters/shared';

/**
 * What a scanned label does on the phone (2026-11-19). Pure, so the rules are
 * tested without a camera.
 */

export interface LastScan {
  code: string;
  at: number;
}

/** A label held in view is read again and again: the same code counts once, then again only after this pause. */
export const SAME_LABEL_PAUSE_MS = 1_500;

/** Whether a read is a new scan: another code, or the same one after the pause. */
export function acceptScan(last: LastScan | null, code: string, now: number, pause: number = SAME_LABEL_PAUSE_MS): boolean {
  if (!code.trim()) return false;
  return !last || normalizeStockCode(last.code) !== normalizeStockCode(code) || now - last.at >= pause;
}

/**
 * One more of the scanned item on the slip being made, and what to say. An
 * item that is not offered (not in this truck, or never taken for this job)
 * is said and not added; so is one already at all there is.
 */
export function scanOntoSlip(
  offered: readonly JobStockItem[],
  quantities: Readonly<Record<string, number>>,
  scanned: string,
  mode: PhoneSlipKind,
  /**
   * Every item in use, and the truck's name (2026-11-24): a code that is no
   * item is said apart from an item that is not in this truck. Without them,
   * every code not offered is "not in this truck", as before.
   */
  known?: { catalog: readonly PhoneCatalogItem[]; placeName: string },
): { quantities: Record<string, number>; said: { words: string; bad: boolean } } {
  const code = normalizeStockCode(scanned);
  const item = offered.find((one) => one.code === code);
  const kept = { ...quantities };
  // A label is an item code: anything else the camera finds (a web address on a box) is not shown back in full.
  const shown = code.slice(0, 24);
  if (!item) {
    if (known?.catalog.length && !known.catalog.some((one) => one.code === code)) return { quantities: kept, said: { words: `${shown} is not an item code. Check the label, or type it.`, bad: true } };
    if (mode === 'RETURN') return { quantities: kept, said: { words: `${shown} was not taken for this job.`, bad: true } };
    return { quantities: kept, said: { words: known ? `${shown} is not in ${known.placeName}.` : `${shown} is not in this truck.`, bad: true } };
  }
  const now = kept[item.itemId] ?? 0;
  if (now >= item.quantity) return { quantities: kept, said: { words: mode === 'RETURN' ? `That is all ${item.quantity} of ${item.name} taken.` : `That is all ${item.quantity} of ${item.name} in the truck.`, bad: true } };
  kept[item.itemId] = now + 1;
  const left = item.quantity - now - 1;
  return {
    quantities: kept,
    said: { words: mode === 'RETURN' ? `${item.code} · ${item.name}: ${now + 1} going back.` : `${item.code} · ${item.name}: ${now + 1} taken. ${left} left. Scan it again for one more.`, bad: false },
  };
}
