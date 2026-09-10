import { InspectionType } from '@prisma/client';

/**
 * Recognising an inspection report among a building's documents.
 *
 * Propertyware keeps every file for a property against the *building*, in one
 * undifferentiated list: leasing agreements, flood certificates, renewal
 * paperwork, and — the reason this exists — the Inspect & Cloud reports the
 * office has been importing one at a time. 7306 Cypress Prairie alone holds 56
 * documents, thirteen of them inspections spanning 2019 to 2026.
 *
 * There is no field that says which is which. `/docs` returns a filename, a
 * MIME type and two timestamps, and `entityType` is `BUILDING` for all of them
 * — the REST `/inspections` module is denied to this API client, so a document
 * cannot be joined to the inspection it documents. The filename is all there is
 * to go on before downloading, and some of these are 81 MB.
 *
 * So classification happens twice, and the two are not interchangeable:
 *
 * 1. {@link classifyFileName} decides what is *worth downloading*. It is a
 *    guess from a name somebody typed, and it is wrong sometimes.
 * 2. {@link classifyTemplate} reads the report's own `Inspection Template:`
 *    line once the bytes are here. That is what Inspect & Cloud recorded, and
 *    it is the answer that gets stored.
 */

/**
 * Every entity Propertyware can file a document against.
 *
 * Straight from the `/docs` parameter documentation, and worth having in full
 * even though only `BUILDING` is walked today: the office wants the rest
 * eventually, and a narrower union would have to be widened by somebody who
 * first has to rediscover what the accepted values are. `DESKTOP` and `OTHER`
 * are the two that take no `entityId`.
 */
export type PropertywareDocumentEntity =
  | 'APPOINTMENT'
  | 'ASSET'
  | 'BILL'
  | 'BANK_DEPOSIT'
  | 'BILL_PAYMENT'
  | 'BUILDING'
  | 'CONTACT'
  | 'FLOOR_PLAN'
  | 'DESKTOP'
  | 'EMAIL_TEMPLATE'
  | 'INSPECTION'
  | 'LEASE'
  | 'OTHER'
  | 'PORTFOLIO'
  | 'PROSPECT'
  | 'RECONCILIATION'
  | 'TASK'
  | 'TRANSACTION'
  | 'UNIT'
  | 'VENDOR'
  | 'WORK_ORDER'
  | 'SERVICE_AGREEMENT';

/** The documented ceiling. The default of 100 pages a long history for nothing. */
export const PROPERTYWARE_DOCUMENT_PAGE_SIZE = 500;

/** One row of `GET /docs?entityType=BUILDING&entityId=…`. */
export interface PropertywareDocument {
  id: number;
  fileName: string;
  fileType: string | null;
  description: string | null;
  entityType: string;
  entityId: number;
  createdBy: string | null;
  createdDateTime: string | null;
  lastModifiedDateTime: string | null;
}

/**
 * What a document turned out to be.
 *
 * Four of these are not inspection types and never become one, and they are not
 * equivalent:
 *
 * - `COMPARISON` — a "MOVE IN VS MOVE OUT" summary written for an owner.
 *   Importing it as either type would attach one walkthrough's evidence to the
 *   other's record.
 * - `NOT_AN_INSPECTION` — somebody else's visit filed against the property: an
 *   HOA walk, a municipal compliance inspection.
 * - `UNKNOWN` — a name nobody anticipated. **Still downloaded**, because the
 *   filename is only a guess and the report states its own template; see
 *   {@link worthDownloading}.
 */
export type DocumentKind =
  | InspectionType
  | 'COMPARISON'
  | 'NOT_AN_INSPECTION'
  | 'UNKNOWN';

/**
 * Case, punctuation and Propertyware's inconsistent separators all removed.
 *
 * `occupiedinspection` is why the last step exists. Four real files are named
 * that way, with no separator at all, and every rule here is anchored on word
 * boundaries — so "occupied" never matched and four occupied inspections sat
 * unclassified. Splitting a glued "…inspection" puts them back in reach
 * without loosening any of the boundaries that stop "mo" matching inside
 * "moisture".
 */
const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.pdf$/, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z])inspection\b/g, '$1 inspection')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The office's own words for each type, longest-first within each group.
 *
 * Order across the whole list matters and is the part to be careful with.
 * "move in vs move out" contains both "move in" and "move out", so the
 * comparison test has to come first or the file lands on whichever type is
 * checked earlier. Likewise `ingoing` is Inspect & Cloud's word for a move-in
 * and appears in filenames the office wrote by hand.
 */
const FILENAME_RULES: ReadonlyArray<[RegExp, DocumentKind]> = [
  // Comparisons first: they name both types and are neither.
  [/\bmove\s?in\s?(vs|versus|v)\s?move\s?out\b|\bmi\s?(vs|v)\s?mo\b/, 'COMPARISON'],
  // Somebody else's inspection, filed here because it concerns the property: a
  // homeowners' association walk, a municipal compliance visit. Not a
  // walkthrough of the tenancy, and not ours to import.
  [/\bhoa\b|\bcity of [a-z]+\b|\bmunicipal\b/, 'NOT_AN_INSPECTION'],
  // Equipment and off-cycle work, which are their own types and must not be
  // read as a tenancy inspection just because the word "inspection" is there.
  [/\bhvac\b|\bac\s?filter\b/, InspectionType.HVAC],
  [/\broof\b/, InspectionType.ROOF],
  [/\blockbox\b|\bsupra\b/, 'UNKNOWN'],
  // Occupied. "Routine" is the older template name for the same visit, and
  // "safety" and the day-count visits are all walked as occupied inspections.
  // `saftey` is not a typo here. It is a typo in Propertyware, and correcting
  // the office's spelling in their own filenames is not on offer.
  [/\boccupied\b|\broutine\b|\bsafety\b|\bsaftey\b|\bclean\s?check\b/, InspectionType.OCCUPIED],
  [/\b\d{2,3}\s?day\b/, InspectionType.OCCUPIED],
  // Move-out before move-in: "mo" is a substring risk either way, but the
  // long forms are unambiguous and checked first.
  // `exit` is the office's other word for a move-out, on thirteen files.
  // "Turnover" and "TO Inspection" are deliberately *not* here: 39 files, and
  // genuinely ambiguous between a move-out and a back-to-market. They stay
  // UNKNOWN, which now means "download it and read the template" rather than
  // "discard it" — see `worthDownloading`.
  [/\bmove\s?out\b|\bmoveout\b|\boutgoing\b|\bexit\b/, InspectionType.MOVE_OUT],
  [/\bmove\s?in\b|\bmovein\b|\bingoing\b/, InspectionType.MOVE_IN],
  // The abbreviations the office uses, anchored as whole words so "mo" cannot
  // match inside "moisture" and "mi" cannot match inside "mildew".
  [/\bmo\b/, InspectionType.MOVE_OUT],
  [/\bmi\b/, InspectionType.MOVE_IN],
  [/\bbtm\b|\bback\s?to\s?market\b/, InspectionType.BACK_TO_MARKET],
];

/**
 * Whether this file is worth downloading at all.
 *
 * Deliberately narrow: the word "inspection" has to be in the name. A looser
 * rule matched `Texas_Renters.com_PM_renewal_2024.pdf` and `PMA Renewals
 * 2023.pdf` on the word "renewal" — property-management agreements, not
 * inspections, and each one a multi-megabyte download and a parse that fails.
 *
 * The cost of being narrow is a report named without the word, which is
 * recoverable: it stays in Propertyware and can be imported by hand, exactly as
 * today. The cost of being loose is thousands of pointless downloads.
 */
export function looksLikeInspectionReport(document: PropertywareDocument): boolean {
  if ((document.fileType ?? '').toLowerCase() !== 'application/pdf') return false;
  return /inspection/i.test(document.fileName ?? '');
}

/** A first guess, from the only thing available before downloading. */
export function classifyFileName(fileName: string): DocumentKind {
  const name = normalise(fileName ?? '');
  for (const [pattern, kind] of FILENAME_RULES) if (pattern.test(name)) return kind;
  return 'UNKNOWN';
}

/**
 * What the report says it is, which outranks its filename.
 *
 * The template line comes from the PDF's own text layer, and that text arrives
 * with **spurious spaces inside words** — "Ingo ing Inspect io n",
 * "Ro ut ine Inspect io n". They are glyph positions, not characters: the
 * extractor emits a run whenever the renderer repositioned the pen, and this
 * report's font metrics do that mid-word. Matching on the raw string finds
 * nothing, so every space is stripped before comparison rather than collapsed.
 */
export function classifyTemplate(template: string | null | undefined): DocumentKind {
  const value = (template ?? '').toLowerCase().replace(/\s+/g, '');
  if (!value) return 'UNKNOWN';
  if (value.includes('ingoing') || value.includes('movein')) return InspectionType.MOVE_IN;
  if (value.includes('outgoing') || value.includes('moveout')) return InspectionType.MOVE_OUT;
  // "Routine" and "Occupied" are the same visit under two template names; the
  // office renamed it, and reports under both are still in Propertyware.
  if (value.includes('occupied') || value.includes('routine')) return InspectionType.OCCUPIED;
  if (value.includes('hvac') || value.includes('acfilter')) return InspectionType.HVAC;
  if (value.includes('roof')) return InspectionType.ROOF;
  if (value.includes('backtomarket')) return InspectionType.BACK_TO_MARKET;
  return 'UNKNOWN';
}

/** Only these become an inspection; the rest are catalogued and left alone. */
export function isImportableKind(kind: DocumentKind): kind is InspectionType {
  return kind !== 'COMPARISON' && kind !== 'NOT_AN_INSPECTION' && kind !== 'UNKNOWN';
}

/**
 * Whether to fetch the bytes, which is a different question from what it is.
 *
 * `UNKNOWN` is downloaded on purpose. The filename is a guess and the report's
 * own template line is the answer, so a name nobody anticipated should cost a
 * download and then be decided properly — not be discarded unread. "Turnover
 * Inspection" and "TO Inspection" are the live example: 39 files that are
 * genuinely ambiguous between a move-out and a back-to-market, and guessing
 * either from the name would be inventing a fact the PDF already states.
 *
 * The two that are never fetched are the two that are certainly not one
 * inspection: an owner's move-in-versus-move-out summary, and somebody else's
 * HOA or municipal visit.
 */
export function worthDownloading(kind: DocumentKind): boolean {
  return kind !== 'COMPARISON' && kind !== 'NOT_AN_INSPECTION';
}

/**
 * The date the report was written, when the filename carries one.
 *
 * Used only to order and to report, never to date the inspection — the parsed
 * report states its own date and that is the one that counts. The office writes
 * these as MMDDYYYY or MM-DD-YYYY appended to the name, and sometimes not at
 * all.
 */
export function dateFromFileName(fileName: string): string | null {
  const digits = /(\d{2})[-_. ]?(\d{2})[-_. ]?(\d{4})/.exec(fileName ?? '');
  if (!digits) return null;
  const [, month, day, year] = digits;
  const asNumber = { month: Number(month), day: Number(day), year: Number(year) };
  // A file numbered "1123 Runneburg" is an address, not a date. Rejecting an
  // impossible one costs nothing; accepting it puts a report in 1123 AD.
  if (asNumber.month < 1 || asNumber.month > 12) return null;
  if (asNumber.day < 1 || asNumber.day > 31) return null;
  if (asNumber.year < 2000 || asNumber.year > 2100) return null;
  return `${year}-${month}-${day}`;
}
