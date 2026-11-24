import { jobStockTaken, type JobStock, type JobStockItem, type PhoneSlipKind, type RecordJobStockInput } from '@texasrenters/shared';

/**
 * A job's materials on the phone (2026-11-19, phase 7): what the screen makes
 * of what the server sent and what this phone is still holding.
 *
 * Pure, so the rules are tested without a renderer. A slip the phone has
 * recorded but the server has not yet confirmed (no signal, or the app closed
 * mid-send) already counts on this phone: it comes off what the truck shows
 * and is listed as waiting. Nobody takes the same filter twice because the
 * first tap has not landed.
 */

/** A slip kept on the phone until the server answers. */
export interface PendingSlip extends RecordJobStockInput {
  inspectionId: string;
  /** What each line is, as the screen showed it when it was recorded: the server's list may have moved on. */
  named: JobStockItem[];
  queuedAt: string;
}

/** A slip the server refused after the phone had kept it: said to the technician, never dropped quietly. */
export interface RefusedSlip {
  clientRequestId: string;
  inspectionId: string;
  kind: PhoneSlipKind;
  named: JobStockItem[];
  reason: string;
  at: string;
}

/**
 * The phone's own key for one slip. Letters, digits and dashes, long enough
 * that two taps never share one; not a UUID, which this runtime cannot be
 * relied on to make.
 */
export function newSlipKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = Array.from({ length: 3 }, () => Math.floor(random() * 0xffffffff).toString(36).padStart(7, '0')).join('');
  return `slip-${now.toString(36)}-${tail}`;
}

/** What is in a truck, by item, less what this phone has taken and not yet sent, plus what it is putting back. */
export function truckStock(stock: JobStock['stock'], placeId: string, pending: readonly PendingSlip[]): JobStockItem[] {
  const items = new Map<string, JobStockItem>();
  for (const row of stock) if (row.placeId === placeId) items.set(row.itemId, { itemId: row.itemId, code: row.code, name: row.name, unit: row.unit, quantity: row.quantity });
  for (const slip of pending) {
    if (slip.placeId !== placeId) continue;
    for (const line of slip.named) {
      const kept = items.get(line.itemId) ?? { ...line, quantity: 0 };
      kept.quantity += slip.kind === 'RETURN' ? line.quantity : -line.quantity;
      items.set(line.itemId, kept);
    }
  }
  return [...items.values()].filter((item) => item.quantity > 0).sort((left, right) => left.code.localeCompare(right.code));
}

/** What was taken for the job and can still go back, counting what this phone is holding. */
export function takenForJob(taken: readonly JobStockItem[], pending: readonly PendingSlip[]): JobStockItem[] {
  const items = new Map(taken.map((item) => [item.itemId, { ...item }]));
  for (const slip of pending)
    for (const line of slip.named) {
      const kept = items.get(line.itemId) ?? { ...line, quantity: 0 };
      kept.quantity += slip.kind === 'RETURN' ? -line.quantity : line.quantity;
      items.set(line.itemId, kept);
    }
  return [...items.values()].filter((item) => item.quantity > 0).sort((left, right) => left.code.localeCompare(right.code));
}

/**
 * What can go back into one truck (2026-11-24): what was taken from that truck
 * for the job, with what this phone is holding for it. Only into the truck it
 * came from -- the server refuses anything else, because putting back into
 * another truck would move stock between trucks, which stays with the office.
 */
export function takenFromTruck(slips: JobStock['slips'], pending: readonly PendingSlip[], placeId: string): JobStockItem[] {
  return takenForJob(
    jobStockTaken(slips, placeId),
    pending.filter((slip) => slip.placeId === placeId),
  );
}

/** The lines of a slip from what the steppers hold: only what was asked for, in the list's order. */
export function slipLines(offered: readonly JobStockItem[], quantities: Readonly<Record<string, number>>): { lines: RecordJobStockInput['lines']; named: JobStockItem[] } {
  const named = offered.flatMap((item) => ((quantities[item.itemId] ?? 0) > 0 ? [{ ...item, quantity: quantities[item.itemId]! }] : []));
  return { lines: named.map((item) => ({ itemId: item.itemId, quantity: item.quantity })), named };
}

/** One more or one fewer, never below nothing or above what there is. */
export function stepped(quantities: Readonly<Record<string, number>>, itemId: string, by: number, most: number): Record<string, number> {
  const next = Math.max(0, Math.min(most, (quantities[itemId] ?? 0) + by));
  return { ...quantities, [itemId]: next };
}

/** "2 × Filter 20x25x1, 1 × Battery, 9 V". */
export const slipSummary = (lines: readonly JobStockItem[]) => lines.map((line) => `${line.quantity} × ${line.name}`).join(', ');

/** Whether the job screen shows its Materials card at all: only where the office keeps a truck for this technician, or something was recorded. */
export const showsMaterials = (stock: Pick<JobStock, 'places' | 'slips'> | undefined, pending: readonly PendingSlip[], refused: readonly RefusedSlip[]) =>
  Boolean(stock?.places.length || stock?.slips.length || pending.length || refused.length);

/** The card's one line: what the job has used so far. */
export function materialsLine(taken: readonly JobStockItem[], waiting: number): string {
  const units = taken.reduce((sum, item) => sum + item.quantity, 0);
  const used = units ? `${units} ${units === 1 ? 'item' : 'items'} taken for this job` : 'Nothing taken for this job yet';
  return waiting ? `${used} · ${waiting} waiting to send` : used;
}
