import { normalizeStockCode, type PhoneCount, type PhoneCountLine, type PhoneCountedLine } from '@texasrenters/shared';

/**
 * Counting a truck on the phone (2026-11-19): what the screen makes of what
 * the server sent and what this phone is still holding. Pure, so the rules
 * are tested without a camera or a renderer.
 *
 * The count is blind: nothing here knows what the office expects, so nothing
 * here can show it. A number typed and not yet confirmed by the server (no
 * signal, or the app closed mid-send) already counts on this phone.
 */

/** What this phone has counted for one count and the server has not confirmed. The newest replaces the older: a count is set, not added. */
export interface PendingCount {
  countId: string;
  /** "Monthly count, November 2026 · Truck 1", for saying so if the office later refuses it. */
  title: string;
  lines: PhoneCountedLine[];
  handIn: boolean;
  queuedAt: string;
}

/** A count the server refused after the phone had kept it: said to the technician, never dropped quietly. */
export interface RefusedCount {
  countId: string;
  title: string;
  reason: string;
  at: string;
}

/** The lines as the screen shows them: the server's, with what this phone is holding laid over. */
export function countLines(lines: readonly PhoneCountLine[], pending: PendingCount | null): PhoneCountLine[] {
  if (!pending) return [...lines];
  // Only a number for the same count of the line: a first count held on the phone is not the second.
  const held = new Map(pending.lines.map((line) => [`${line.lineId}|${line.second}`, line.counted]));
  return lines.map((line) => {
    const counted = held.get(`${line.lineId}|${line.second}`);
    return counted === undefined ? line : { ...line, counted };
  });
}

/** One line counted: the rest untouched. */
export const withCount = (lines: readonly PhoneCountLine[], lineId: string, counted: number): PhoneCountLine[] => lines.map((line) => (line.lineId === lineId ? { ...line, counted } : line));

/** What is sent: every line that has a number, each saying which count of the line it is. */
export const countedLines = (lines: readonly PhoneCountLine[]): PhoneCountedLine[] => lines.flatMap((line) => (line.counted === null ? [] : [{ lineId: line.lineId, counted: line.counted, second: line.second }]));

/** The line a scanned label names, or why there is none. */
export function scannedCountLine(lines: readonly PhoneCountLine[], scanned: string): { line: PhoneCountLine } | { said: string } {
  const code = normalizeStockCode(scanned);
  const line = lines.find((one) => one.code === code);
  // A label is an item code: anything else the camera finds is not read back in full.
  return line ? { line } : { said: `${code.slice(0, 24)} is not in this count.` };
}

/** "7 of 11 counted". */
export function countProgress(lines: readonly PhoneCountLine[]): string {
  return `${lines.filter((line) => line.counted !== null).length} of ${lines.length} counted`;
}

/** The home card's line for a count: what is left to do. */
export function countCardLine(count: Pick<PhoneCount, 'lines'>, pending: PendingCount | null): string {
  if (pending?.handIn) return 'Handed in · waiting to send';
  const lines = countLines(count.lines, pending);
  const left = lines.filter((line) => line.counted === null).length;
  const second = lines.some((line) => line.second);
  if (!left) return 'Every item is counted. Hand it in.';
  return `${left} ${left === 1 ? 'item' : 'items'} to count${second ? ' a second time' : ''}`;
}

/** The count's name with its truck, as the phone says it. */
export const countName = (count: Pick<PhoneCount, 'title' | 'place'>) => `${count.title} · ${count.place.name}`;
