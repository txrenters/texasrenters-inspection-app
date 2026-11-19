/**
 * Which label goes where (2026-11-19). Pure, so it is tested without a PDF.
 *
 * Two papers. A sheet of thirty (Avery 5160: three across, ten down, on
 * Letter) for the office printer, which may start part-way down a sheet that
 * has had labels peeled off already. A roll for a label printer, one label a
 * page, 2.25 by 1.25 inches.
 */

export type LabelPaper = 'SHEET' | 'ROLL';

export interface LabelPick {
  code: string;
  name: string;
  unit: string;
  copies: number;
}

export interface Label {
  code: string;
  name: string;
  unit: string;
}

/** Points: 72 to the inch. */
export const LABEL_PAPERS = {
  SHEET: { name: 'Sheet of 30 labels (Avery 5160)', page: { width: 612, height: 792 }, label: { width: 189, height: 72 }, across: 3, down: 10, top: 36, left: 13.5, gapAcross: 9 },
  ROLL: { name: 'Label printer roll, one label a page (2.25 × 1.25 in)', page: { width: 162, height: 90 }, label: { width: 162, height: 90 }, across: 1, down: 1, top: 0, left: 0, gapAcross: 0 },
} as const;

export const MOST_COPIES = 99;
/** One PDF holds at most this many labels: twenty sheets. More is a second print. */
export const MOST_LABELS = 600;

/** A typed number of copies as a whole number from 0 to the most, or null when it is not one. */
export function readCopies(typed: string): number | null {
  if (!/^\d{1,2}$/.test(typed.trim())) return null;
  return Number(typed.trim());
}

/** Every label to print, in the list's order, each item as many times as asked. */
export const labelsOf = (picks: readonly LabelPick[]): Label[] => picks.flatMap((pick) => Array.from({ length: Math.max(0, pick.copies) }, () => ({ code: pick.code, name: pick.name, unit: pick.unit })));

/**
 * The pages, each a list of places on the paper: a label, or null for a place
 * left empty. `startAt` (1 to 30) skips the places already used on the first
 * sheet; a roll has one place a page and starts at the first.
 */
export function labelPages(picks: readonly LabelPick[], paper: LabelPaper, startAt = 1): (Label | null)[][] {
  const each = LABEL_PAPERS[paper].across * LABEL_PAPERS[paper].down;
  const skipped = paper === 'SHEET' ? Math.min(Math.max(1, Math.trunc(startAt) || 1), each) - 1 : 0;
  const places: (Label | null)[] = [...Array.from({ length: skipped }, () => null), ...labelsOf(picks)];
  const pages: (Label | null)[][] = [];
  for (let offset = 0; offset < places.length; offset += each) pages.push(places.slice(offset, offset + each));
  // A sheet that would hold only skipped places is no sheet at all.
  return pages.filter((page) => page.some(Boolean));
}

/** Why these cannot be printed yet, or null. */
export function labelsProblem(picks: readonly LabelPick[]): string | null {
  const count = labelsOf(picks).length;
  if (!count) return 'Tick at least one item code.';
  if (count > MOST_LABELS) return `That is ${count} labels. One print holds up to ${MOST_LABELS}; print the rest after.`;
  return null;
}

/** "3 items, 14 labels". */
export function labelsSummary(picks: readonly LabelPick[]): string {
  const items = picks.filter((pick) => pick.copies > 0).length;
  const count = labelsOf(picks).length;
  return `${items} ${items === 1 ? 'item' : 'items'}, ${count} ${count === 1 ? 'label' : 'labels'}`;
}
