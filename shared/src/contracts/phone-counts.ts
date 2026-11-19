import { MOST_STOCK_QUANTITY } from './inventory.js';

/**
 * Counting a truck from the phone (2026-11-19). The office starts a count on
 * the console; when it is of a truck, the technician on that truck (or any
 * technician, for a truck nobody is named on) may count it from the phone by
 * scanning each label and typing how many are there.
 *
 * The same count, the same rules: it is blind, so nothing here carries what
 * the console expects; whoever counts is never the one who approves; and a
 * line far out comes back to be counted a second time. The phone never
 * starts, reviews, posts or cancels a count, and never counts a storeroom.
 */

export interface PhoneCountLine {
  lineId: string;
  itemId: string;
  code: string;
  name: string;
  unit: string;
  /** What has been counted so far; null when it has not been. */
  counted: number | null;
  /** True when this line is being counted a second time. */
  second: boolean;
}

export interface PhoneCount {
  id: string;
  number: string;
  /** "Monthly count, November 2026". */
  title: string;
  place: { id: string; name: string };
  /** The lines still to be counted and handed in. */
  lines: PhoneCountLine[];
}

export interface PhoneCounts {
  counts: PhoneCount[];
}

export interface PhoneCountedLine {
  lineId: string;
  counted: number;
  /**
   * Which count of the line this is, as the phone saw it: the first, or the
   * second asked for after a first that was far out. It is what makes a
   * hand-in sent twice record once: a first count that arrives again after
   * the line went back for a second is recognised and not taken as the second.
   */
  second: boolean;
}

export interface SavePhoneCountInput {
  lines: PhoneCountedLine[];
  /** True to hand the count in; false to keep what is counted so far. */
  handIn: boolean;
}

export interface SavePhoneCountResult extends PhoneCounts {
  /** `saved`: kept so far. `handed-in`: gone for review. `recount`: some lines came back. `already`: this had been received before. */
  outcome: 'saved' | 'handed-in' | 'recount' | 'already';
  /** How many lines came back for a second count. */
  recounts: number;
}

/** A typed count as a whole number of units, or null when it is not one. */
export function readPhoneCount(typed: string): number | null {
  const text = typed.trim();
  if (!/^\d{1,7}$/.test(text)) return null;
  const value = Number(text);
  return value <= MOST_STOCK_QUANTITY ? value : null;
}

/** Why the count cannot be handed in yet, or null. */
export function phoneCountProblem(lines: readonly Pick<PhoneCountLine, 'counted'>[]): string | null {
  const left = lines.filter((line) => line.counted === null).length;
  if (left) return left === 1 ? '1 item is not counted yet.' : `${left} items are not counted yet.`;
  return null;
}
