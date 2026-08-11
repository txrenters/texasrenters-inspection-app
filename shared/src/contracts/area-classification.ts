/**
 * What kind of space an area's name describes.
 *
 * The floor-plan model returns a name and nothing else — no environment, no
 * category — so every extracted area landed in the database as the schema
 * default, `INDOOR` with no category. A patio was therefore stored as an indoor
 * room and handed the indoor checklist: doors, walls **and ceilings**, windows.
 * Nobody notices reading a checklist that a lawn has no ceiling until a
 * technician is standing on it.
 *
 * Deterministic, for the same reasons as [checklistTemplateFor]: it must give
 * the same answer offline, it can be diffed and reviewed, and a misclassified
 * area is a wrong checklist rather than a wrong sentence. The model is better
 * used for reading the plan than for restating what "Back Yard" means.
 *
 * Deliberately conservative. Anything unrecognised is an ordinary indoor room,
 * which is both the commonest case and the safe one: an indoor checklist on an
 * outdoor area is visibly wrong to whoever reviews it, whereas the reverse
 * quietly drops the walls-and-ceilings line from a bedroom.
 */

export type AreaEnvironmentValue = 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR';

export interface AreaClassification {
  environment: AreaEnvironmentValue;
  /** A value of the `AreaCategory` enum. */
  category: string;
  /**
   * Whether the area is inspected by default. Outdoor space and garages are
   * offered but not demanded — the same judgement the extraction service used
   * to make with its own copy of this vocabulary.
   */
  isRequired: boolean;
}

/**
 * Ordered, most specific first. Two rules overlap on purpose and the order is
 * what separates them: "Entry hall" is an entrance, plain "Hall" is a hallway.
 *
 * `category` stays `INDOOR_ROOM` for ordinary rooms — kitchens, bedrooms,
 * bathrooms — even though the name identifies them perfectly well. That is not
 * an oversight: [checklistTemplateFor] treats a set category as authoritative
 * and only consults the name when the category is unspecific, so naming the
 * room type here would *bypass* the checklist's own room rules rather than help
 * them. `INDOOR_ROOM` means "a room, kind not asserted", which is exactly true.
 */
const RULES: { test: RegExp; environment: AreaEnvironmentValue; category: string }[] = [
  // Outdoor proper: no roof, no walls, nothing the indoor list asks about.
  { test: /\byards?\b|garden|lawn|backyard|back\s?yard|front\s?yard/i, environment: 'OUTDOOR', category: 'YARD' },
  { test: /driveway|carpark|parking/i, environment: 'OUTDOOR', category: 'DRIVEWAY' },
  { test: /\bpool\b|spa\b|jacuzzi/i, environment: 'OUTDOOR', category: 'POOL' },
  { test: /\bshed\b|outbuilding/i, environment: 'OUTDOOR', category: 'SHED' },
  { test: /\bfenc(e|ing)\b|perimeter/i, environment: 'OUTDOOR', category: 'PERIMETER_FENCE' },
  { test: /\bgates?\b/i, environment: 'OUTDOOR', category: 'GATE' },
  { test: /\broof\b|rooftop/i, environment: 'OUTDOOR', category: 'ROOF' },

  // Attached and often covered, but walked like the outside.
  { test: /balcon(y|ies)/i, environment: 'SEMI_OUTDOOR', category: 'BALCONY' },
  { test: /porch|lanai|veranda/i, environment: 'SEMI_OUTDOOR', category: 'PORCH' },
  { test: /patio|deck\b|terrace|courtyard/i, environment: 'SEMI_OUTDOOR', category: 'PATIO' },

  // Enclosed, so the indoor base applies — a garage has doors, walls and
  // lights. The report gives GARAGE/CARPORT the indoor list plus shelving.
  { test: /garage|carport|workshop/i, environment: 'INDOOR', category: 'GARAGE' },
  { test: /\battic\b|loft\b|crawl\s?space/i, environment: 'INDOOR', category: 'ATTIC' },
  { test: /basement|cellar/i, environment: 'INDOOR', category: 'BASEMENT' },
  { test: /laundry|utility|mud\s?room|boiler|furnace/i, environment: 'INDOOR', category: 'UTILITY' },
  { test: /closet|wardrobe|pantry/i, environment: 'INDOOR', category: 'CLOSET' },
  { test: /stair|stairway|stairwell/i, environment: 'INDOOR', category: 'STAIRWAY' },
  // Before the hallway rule: an entrance gets its own checklist, and "Entry
  // hall" would otherwise be read as a corridor.
  { test: /entrance|entry|foyer|vestibule/i, environment: 'INDOOR', category: 'INDOOR_ROOM' },
  { test: /hall|corridor|landing|passage/i, environment: 'INDOOR', category: 'HALLWAY' },
];

/** Areas that are offered rather than demanded. */
function requiredFor(environment: AreaEnvironmentValue, category: string) {
  return environment === 'INDOOR' && category !== 'GARAGE';
}

export function classifyAreaByName(name: string | null | undefined): AreaClassification {
  const value = (name ?? '').trim();
  const matched = value ? RULES.find((rule) => rule.test.test(value)) : undefined;
  const environment = matched?.environment ?? 'INDOOR';
  const category = matched?.category ?? 'INDOOR_ROOM';
  return { environment, category, isRequired: requiredFor(environment, category) };
}
