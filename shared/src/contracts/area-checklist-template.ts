/**
 * The default coverage checklist for an area.
 *
 * Transcribed from the TexasRenters inspection report for 17307 Nordway Dr,
 * which is the house standard: every indoor area shares a base set, each kind
 * of room adds its own items, and outdoor areas replace the base rather than
 * extending it.
 *
 * Deterministic rather than inferred. The report *is* the standard, so there is
 * little to guess; a fixed table can be read, reviewed and diffed, it produces
 * the same list on a phone with no signal, and it cannot invent an item nobody
 * approved. AI belongs in suggesting additions for a genuinely unusual area,
 * as a draft an administrator accepts — not in deciding the routine ones.
 *
 * One tick per item. The source report grades each on three axes — clean,
 * undamaged, working — which is deliberately not modelled here: the app records
 * whether an item was covered, and the condition of what was found belongs to
 * the finding, not the checklist.
 */

/** Bumped when the tables below change, so regenerated lists can be told apart. */
export const CHECKLIST_TEMPLATE_VERSION = 'nordway-2026-08';

/** Words too common to identify anything when spoken aloud. */
const CHECKLIST_STOP_WORDS = new Set([
  'and',
  'any',
  'are',
  'for',
  'its',
  'not',
  'the',
  'their',
  'this',
  'with',
]);

/**
 * The words an item is matched on when no keywords were authored.
 *
 * Here rather than beside the API's create handler because generated items and
 * hand-written ones must derive keywords identically — a template item that
 * matched differently from the same label typed by an administrator would tick
 * itself under different conditions.
 *
 * Plurals reduce to the singular because the matcher accepts either form, so
 * "tap" covers "tap" and "taps" while "taps" covers only the plural.
 */
export function keywordsFromLabel(label: string): string[] {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !CHECKLIST_STOP_WORDS.has(word))
    // "glass", "status" and "analysis" are not plurals, so a trailing -s counts
    // as one only when what precedes it is not s, u or i.
    .map((word) => (word.length > 3 && /[^siu]s$/.test(word) ? word.slice(0, -1) : word));
  return [...new Set(words)];
}

/** In every indoor area, whatever else it holds. */
const BASE_INDOOR = [
  'Doors and locks',
  'Walls and ceilings',
  'Floor and coverings',
  'Windows and locks',
  'Lights and power points',
];

/**
 * Outdoor areas replace the base rather than adding to it — a lawn has no
 * ceiling, and asking a technician to tick one teaches them to tick anything.
 */
const BASE_OUTDOOR = [
  'Lawn and garden',
  'Gates and fences',
  'External walls',
  'External lights',
  'Gutters and downpipes',
  'Balcony or porch, doors and locks',
  'Outdoor storage',
];

/**
 * What each kind of room adds to the indoor base, in the order the report
 * lists them — technicians read down the page they already know.
 */
const CATEGORY_ADDITIONS: Record<string, string[]> = {
  KITCHEN: [
    'Cupboards, drawers and bench tops',
    'Sink, taps and spouts',
    'Stove, hobs and griller',
    'Refrigerator',
    'Microwave',
    'Dishwasher',
    'Smoke alarms',
  ],
  BATHROOM: [
    'Bath, shower and taps',
    'Basin, vanity and mirror',
    'Toilet and roll holder',
    'Heating and exhaust fan',
  ],
  BEDROOM: ['Blinds and curtains', 'Built-ins and mirrors', 'Closet', 'Smoke alarms'],
  LIVING: ['Blinds and curtains', 'Smoke alarms'],
  ENTRANCE: ['Entry closet'],
  LAUNDRY: ['Wash tubs, taps and spouts', 'Washer', 'Dryer'],
  GARAGE: ['Shelving and workbench', 'Smoke alarms'],
  CLOSET: ['Shelving and hanging rails'],
  // Hallways and stairways take the base alone, as in the report.
  HALLWAY: [],
};

/**
 * Which table an area draws from.
 *
 * `category` is authoritative when set, because an administrator chose it.
 * A technician adding an area on site types a name and picks an environment,
 * so the name is read as a fallback — "Master bath" has to reach the bathroom
 * list without anyone classifying it first.
 *
 * Ordered most specific first: "master bathroom" must not match the bedroom
 * rule on its way past.
 */
const NAME_RULES: { test: RegExp; kind: string }[] = [
  { test: /bath|shower|ensuite|en-suite|powder|w\.?c\.?|toilet|restroom/i, kind: 'BATHROOM' },
  { test: /kitchen|kitchenette|pantry/i, kind: 'KITCHEN' },
  { test: /laundry|utility|mud\s?room/i, kind: 'LAUNDRY' },
  { test: /garage|carport|workshop/i, kind: 'GARAGE' },
  { test: /closet|wardrobe|storage/i, kind: 'CLOSET' },
  { test: /entrance|entry|foyer|hall|corridor|landing|stair/i, kind: 'HALLWAY' },
  { test: /bed|nursery/i, kind: 'BEDROOM' },
  { test: /living|lounge|family|dining|den|study|office|media/i, kind: 'LIVING' },
];

/** Maps the app's AreaCategory enum onto the report's room kinds. */
const CATEGORY_ALIASES: Record<string, string> = {
  GARAGE: 'GARAGE',
  CLOSET: 'CLOSET',
  UTILITY: 'LAUNDRY',
  HALLWAY: 'HALLWAY',
  STAIRWAY: 'HALLWAY',
  ATTIC: 'CLOSET',
  BASEMENT: 'GARAGE',
};

export interface ChecklistTemplateArea {
  name?: string | null;
  /** The app's AreaCategory, when an administrator has set one. */
  category?: string | null;
  environment?: 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR' | null;
}

/**
 * The default items for an area, in the order a technician should walk them.
 *
 * Never empty: an unrecognised indoor area still gets the base set, because
 * every room has doors, walls, a floor and lights. An empty list would leave
 * the technician with nothing to cover and no sign that anything was missing.
 */
export function checklistTemplateFor(area: ChecklistTemplateArea): string[] {
  // Semi-outdoor — a porch, a balcony — is walked like the outside.
  if (area.environment === 'OUTDOOR' || area.environment === 'SEMI_OUTDOOR') {
    return [...BASE_OUTDOOR];
  }

  const fromCategory = area.category ? CATEGORY_ALIASES[area.category.toUpperCase()] : undefined;
  const fromName = area.name
    ? NAME_RULES.find((rule) => rule.test.test(area.name as string))?.kind
    : undefined;
  // An explicit INDOOR_ROOM says "a room", not which kind, so the name still
  // decides between a kitchen and a bedroom.
  const kind = fromCategory ?? fromName;

  return [...BASE_INDOOR, ...(kind ? (CATEGORY_ADDITIONS[kind] ?? []) : [])];
}
