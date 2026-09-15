/**
 * The office's HVAC inspection, as its Inspect & Cloud report walks it.
 *
 * Source: the "HVAC Inspection" template the office's reports were issued from
 * in Inspect & Cloud (10118 Mariposa Green Ct, 2024-01-05), handed over on
 * 2026-09-16 as the design the console and the handset both follow. Four
 * sections -- Attic, Filters, A/C unit, Thermostat -- each a table of items
 * scored Clean / Undamaged / Working with a comment, each item photographed, and
 * the report closing on Next Inspection Alert, Maintenance Comments and General
 * Comments.
 *
 * It replaced the sixty-item transcription of the printed "THMP HVAC Inspection
 * Checklist" signed off on 2026-09-02. The office kept that form's temperature
 * and pressure readings: they ride along in the section where each is taken,
 * typed rather than scored, and never required -- not every visit carries the
 * gauges.
 *
 * Each section is an area of the inspection, named as the section is, so the
 * handset walks them the way it walks rooms and the report prints them the way
 * the old one did: a table per section, photographs beneath.
 */

/** How one item is answered. */
export type HvacResponseType =
  /** Clean / Undamaged / Working plus a comment, as every row of the report is. */
  | 'STATUS'
  /** A number with a unit. Temperature split is diagnosis, not decoration. */
  | 'READING'
  /** Free text. */
  | 'TEXT'
  /** Exactly one of `choices`. */
  | 'CHOICE';

/** The report's sections, in the order it prints them -- and the names of the inspection's areas. */
export const HVAC_SECTIONS = ['Attic', 'Filters', 'A/C unit', 'Thermostat'] as const;
export type HvacSection = (typeof HVAC_SECTIONS)[number];

export interface HvacChecklistItem {
  /** The report's section, which is also the area the item is answered in. */
  section: HvacSection;
  label: string;
  responseType: HvacResponseType;
  /** READING only. Shown beside the field so nobody guesses Celsius. */
  unit?: string;
  /** CHOICE only. */
  choices?: string[];
}

const STATUS = (section: HvacSection, label: string): HvacChecklistItem => ({
  section,
  label,
  responseType: 'STATUS',
});

const READING = (section: HvacSection, label: string, unit: string): HvacChecklistItem => ({
  section,
  label,
  responseType: 'READING',
  unit,
});

export const HVAC_CHECKLIST: readonly HvacChecklistItem[] = [
  STATUS('Attic', 'Float switch'),
  STATUS('Attic', 'Drip pan'),
  STATUS('Attic', 'Media filter'),
  STATUS('Attic', 'Furnace condition'),

  // Four rows whatever the property has, as the report prints them. A property
  // with one filter answers the other three "Not present".
  STATUS('Filters', 'Filter 1'),
  STATUS('Filters', 'Filter 2'),
  STATUS('Filters', 'Filter 3'),
  STATUS('Filters', 'Filter 4'),

  // "R410A" is the comment on this row in the office's own report: the type is
  // written, and the row scored like every other.
  STATUS('A/C unit', 'Refrigerant type'),
  STATUS('A/C unit', 'Coil guard'),
  STATUS('A/C unit', 'Inlet/outlet lines'),
  READING('A/C unit', 'Outdoor temperature', '°F'),
  // The printed form's one "___ / ___ PSI" field, as two readings: they are two
  // measurements, and a single string would have to be parsed by anything that
  // ever compared them.
  READING('A/C unit', 'Refrigerant pressure — suction', 'PSI'),
  READING('A/C unit', 'Refrigerant pressure — liquid', 'PSI'),

  STATUS('Thermostat', 'Temperature'),
  READING('Thermostat', 'Return air temperature', '°F'),
  READING('Thermostat', 'Supply air temperature', '°F'),
  READING('Thermostat', 'Temperature split', '°F'),
] as const;

/** The section headings in the order the report prints them. */
export function hvacChecklistSections(): string[] {
  return [...HVAC_SECTIONS];
}

/**
 * The section an area of an HVAC inspection is, by its name, or null.
 *
 * Null for the single "HVAC System" area inspections were given before the
 * report's sections became areas: those answer the whole list in one place.
 */
export function hvacSectionOf(areaName: string | null | undefined): HvacSection | null {
  const name = (areaName ?? '').trim().toLowerCase();
  return HVAC_SECTIONS.find((section) => section.toLowerCase() === name) ?? null;
}

/** The items an HVAC area asks: its section's, or every item for an area that is not one. */
export function hvacItemsForArea(areaName: string | null | undefined): HvacChecklistItem[] {
  const section = hvacSectionOf(areaName);
  return HVAC_CHECKLIST.filter((item) => !section || item.section === section);
}

/** The comment "Not present" writes, for a row the property does not have -- the report's "Dont have". */
export const HVAC_NOT_PRESENT = 'Not present';

export interface HvacAnswer {
  isClean?: boolean | null;
  isUndamaged?: boolean | null;
  isWorking?: boolean | null;
  comment?: string | null;
}

/**
 * Whether an item is answered well enough to finish its area.
 *
 * A scored row is all three of Clean, Undamaged and Working, as every graded row
 * of the office's report is -- or a comment saying why it could not be, which
 * is how the report records a media filter the property does not have. A
 * reading is never required.
 */
export function hvacItemAnswered(
  item: { responseType?: string | null },
  answer: HvacAnswer | null | undefined,
): boolean {
  if ((item.responseType ?? 'STATUS') !== 'STATUS') return true;
  if (!answer) return false;
  const scored = answer.isClean != null && answer.isUndamaged != null && answer.isWorking != null;
  return scored || Boolean(answer.comment?.trim());
}

/**
 * The items still to answer before an HVAC area can be finished, in order.
 *
 * One rule for the handset's gate and the server's `completeRoom`, so the two
 * cannot disagree about the same area.
 */
export function hvacUnansweredItems<T extends { label: string; responseType?: string | null }>(
  items: readonly T[],
  answerOf: (item: T) => HvacAnswer | null | undefined,
): T[] {
  return items.filter((item) => !hvacItemAnswered(item, answerOf(item)));
}

/** What to tell a technician who has items left, naming them. */
export function hvacUnansweredMessage(labels: readonly string[]): string {
  const named =
    labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ');
  return `Score Clean, Undamaged and Working, or say why not, for ${named}.`;
}
