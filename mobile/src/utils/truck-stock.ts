import { askToKeep, normalizeStockCode, runningLow, truckAskProblem, type AskForTruckStockInput, type MyTruck, type MyTruckItem, type PhoneCatalogItem } from '@texasrenters/shared';

/**
 * The truck on the phone, round 2 (the office, 2026-11-24): what My truck and
 * Ask for more make of what the server sent and what this phone is holding.
 * Pure, so the rules are tested without a renderer.
 *
 * An ask moves no stock: it is only an ask, which the office fills with a move
 * from the Storeroom. One sent with no signal waits on the phone and goes
 * later; if the office then refuses it, the phone says so until it is read.
 */

/** An ask kept on the phone until the server answers. */
export interface PendingAsk extends AskForTruckStockInput {
  /** The truck's name and each line's item, as the screen showed them, for saying what is waiting. */
  placeName: string;
  named: { itemId: string; code: string; name: string; quantity: number }[];
  queuedAt: string;
}

/** An ask the server refused after the phone had kept it: said to the technician, never dropped quietly. */
export interface RefusedAsk {
  clientRequestId: string;
  placeName: string;
  named: PendingAsk['named'];
  reason: string;
  at: string;
}

/** The phone's own key for one ask: letters, digits and dashes. */
export function newAskKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = Array.from({ length: 3 }, () => Math.floor(random() * 0xffffffff).toString(36).padStart(7, '0')).join('');
  return `ask-${now.toString(36)}-${tail}`;
}

/** What has run low on the truck, by code. */
export const lowOn = (truck: Pick<MyTruck, 'items'>): MyTruckItem[] => truck.items.filter(runningLow);

/** The Home card's line: how much is on the truck, and how much has run low. */
export function truckCardLine(truck: Pick<MyTruck, 'items'>): { held: string; low: number } {
  const held = truck.items.filter((item) => item.onHand > 0).length;
  return { held: `${held} ${held === 1 ? 'item' : 'items'} on it`, low: lowOn(truck).length };
}

/** The items whose code or name has the words typed, in the truck's order. */
export function findOnTruck<T extends { code: string; name: string }>(items: readonly T[], typed: string): T[] {
  const words = typed.trim().toLowerCase();
  if (!words) return [...items];
  return items.filter((item) => `${item.code} ${item.name}`.toLowerCase().includes(words));
}

/** One line of an ask being made: ticked or not, with how many. */
export interface AskDraftLine {
  item: { itemId: string; code: string; name: string; unit: string };
  onHand: number;
  keepAtLeast: number | null;
  ticked: boolean;
  quantity: string;
}

/** An ask starts from what has run low, each ticked with what brings it back up to what is kept; the rest of the truck below, unticked. */
export function askDraft(truck: Pick<MyTruck, 'items'>): AskDraftLine[] {
  const line = (item: MyTruckItem): AskDraftLine => ({ item: { itemId: item.itemId, code: item.code, name: item.name, unit: item.unit }, onHand: item.onHand, keepAtLeast: item.keepAtLeast, ticked: runningLow(item), quantity: runningLow(item) ? String(askToKeep(item)) : '' });
  return [...truck.items.filter(runningLow).map(line), ...truck.items.filter((item) => !runningLow(item)).map(line)];
}

/** An item from the office's list, not on the truck, added to the ask by a scan or a search. */
export function withAdded(draft: readonly AskDraftLine[], item: PhoneCatalogItem): AskDraftLine[] {
  const on = draft.find((line) => line.item.itemId === item.itemId);
  if (on) return draft.map((line) => (line.item.itemId === item.itemId ? { ...line, ticked: true, quantity: line.quantity || '1' } : line));
  return [...draft, { item: { itemId: item.itemId, code: item.code, name: item.name, unit: item.unit }, onHand: 0, keepAtLeast: null, ticked: true, quantity: '1' }];
}

/** A typed number of units, or null when it is not a whole number above none. */
export function readAskQuantity(typed: string): number | null {
  const text = typed.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

/** What the ask sends, and why it cannot be sent yet. */
export function askLines(draft: readonly AskDraftLine[]): { lines: AskForTruckStockInput['lines']; named: PendingAsk['named']; problem: string | null } {
  const ticked = draft.filter((line) => line.ticked);
  const bad = ticked.find((line) => readAskQuantity(line.quantity) === null);
  const named = ticked.flatMap((line) => {
    const quantity = readAskQuantity(line.quantity);
    return quantity === null ? [] : [{ itemId: line.item.itemId, code: line.item.code, name: line.item.name, quantity }];
  });
  const lines = named.map((line) => ({ itemId: line.itemId, quantity: line.quantity }));
  return { lines, named, problem: bad ? `Say how many of ${bad.item.name} to ask for.` : truckAskProblem(lines) };
}

/** "3 items · today 10:40 AM". */
export const askSummary = (lineCount: number) => `${lineCount} ${lineCount === 1 ? 'item' : 'items'}`;

/** What a scanned label finds on My truck: the item and how many are on the truck, or why there is none. */
export function scannedOnTruck(truck: Pick<MyTruck, 'items' | 'name'>, catalog: readonly PhoneCatalogItem[], scanned: string): { item: MyTruckItem } | { said: string } {
  const code = normalizeStockCode(scanned);
  const item = truck.items.find((one) => one.code === code);
  if (item) return { item };
  // A label is an item code: anything else the camera finds is not read back in full.
  return catalog.some((one) => one.code === code) ? { said: `${code} is not on ${truck.name}.` } : { said: `${code.slice(0, 24)} is not an item code. Check the label, or type it.` };
}
