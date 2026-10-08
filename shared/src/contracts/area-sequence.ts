/**
 * The order a property's rooms are listed in: always the entrance first, then
 * the house in the order the office reads it (the maintenance team,
 * 2026-10-08). It replaces the order rooms happened to be walked or imported
 * in, everywhere a list of rooms is shown -- the inspection page, the reports,
 * the move-in / move-out comparison -- so the same house reads the same way on
 * every page and every visit.
 *
 * The office's list:
 *
 *   Entrance, Downstairs Living Room, Formal Dining Room, Breakfast Room,
 *   Kitchen, Master Bedroom, Bedroom 1-4, Master Bathroom, Bathroom 1-3,
 *   Bathroom Downstairs, Office Front, Game Room, Stairs, Upstairs Hallway,
 *   Downstairs Hallway, Laundry, Garage, Outside Areas -- or else.
 *
 * Rooms are recognised by name, because names are all the data has: the same
 * room is "Gameroom" at one house and "Game Room" at the next. Numbered rooms
 * go by their number (Bedroom 2 before Bedroom 10). A room the list does not
 * name goes after it ("or else"), and rooms of the same kind keep the order
 * they came in, so nothing a technician walked is shuffled without reason.
 */

interface SequenceRule {
  /** What the office calls it, for tests and for reading this list. */
  name: string;
  matches: (name: string) => boolean;
}

const has = (pattern: RegExp) => (name: string) => pattern.test(name);
const MASTER = /\b(master|primary|main|owner'?s?)\b/;
const BATH = /\b(bath|bathroom|restroom|powder room|half bath|wc)\b/;
const BEDROOM = /\b(bedroom|bed room|br)\b/;
const DOWNSTAIRS = /\b(downstairs|down stairs|lower|1st floor|first floor|ground floor|half|powder)\b/;
const UPSTAIRS = /\b(upstairs|up stairs|upper|2nd floor|second floor)\b/;
const HALL = /\b(hall|hallway|corridor)\b/;

/**
 * In the office's order. Read top to bottom, and the first that matches wins,
 * so the more particular test comes before the general one where a name could
 * pass both ("Master Bathroom" is a bathroom before it is anything "master").
 */
const SUITE = /\bsuite\b/;
const RULES: Array<SequenceRule & { rank: number }> = (<SequenceRule[]>[
  { name: 'Entrance', matches: has(/\b(entrance|entry|entryway|foyer)\b/) },
  { name: 'Downstairs Living Room', matches: has(/\b(living|family room|great room)\b/) },
  { name: 'Formal Dining Room', matches: has(/\bdining\b/) },
  { name: 'Breakfast Room', matches: has(/\b(breakfast|nook)\b/) },
  { name: 'Kitchen', matches: has(/\b(kitchen|kitchenette)\b/) },
  {
    name: 'Master Bedroom',
    matches: (name) => MASTER.test(name) && (BEDROOM.test(name) || SUITE.test(name)) && !BATH.test(name),
  },
  { name: 'Bedroom', matches: (name) => BEDROOM.test(name) && !BATH.test(name) },
  { name: 'Master Bathroom', matches: (name) => MASTER.test(name) && BATH.test(name) },
  {
    name: 'Bathroom Downstairs',
    matches: (name) => BATH.test(name) && DOWNSTAIRS.test(name),
  },
  { name: 'Bathroom', matches: has(BATH) },
  { name: 'Office', matches: has(/\b(office|study|den|library)\b/) },
  { name: 'Game Room', matches: has(/\b(game ?room|games room|media room|bonus room|loft|playroom|play room)\b/) },
  { name: 'Stairs', matches: has(/\b(stairs?|staircase|stairway|stairwell)\b/) },
  { name: 'Upstairs Hallway', matches: (name) => HALL.test(name) && UPSTAIRS.test(name) },
  { name: 'Downstairs Hallway', matches: has(HALL) },
  { name: 'Laundry', matches: has(/\b(laundry|utility|washer|wash room)\b/) },
  { name: 'Garage', matches: has(/\bgarage\b/) },
  {
    name: 'Outside Areas',
    matches: has(/\b(outside|exterior|yard|patio|porch|balcony|deck|driveway|pool|lawn|fence|roof)\b/),
  },
]).map((rule, rank) => ({ ...rule, rank }));

// "Bathroom Downstairs" sits after Bathroom 1-3 in the office's list, so it
// ranks after the numbered bathrooms even though it is tested before them.
const RANK_OVERRIDE: Record<string, number> = { 'Bathroom Downstairs': 9.5 };

/** Lower case, words only, so "Office. Front Of The Home." reads as words. */
function words(name: string) {
  return name
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The office's place for a room name, and its number when it has one. */
export function areaSequenceKey(name: string): { rank: number; number: number; kind: string } {
  const text = words(name);
  const rule = RULES.find((entry) => entry.matches(text));
  const number = Number(text.match(/\b(\d+)\b/)?.[1] ?? Number.NaN);
  if (!rule) return { rank: RULES.length, number: Number.isNaN(number) ? 0 : number, kind: 'Else' };
  return {
    rank: RANK_OVERRIDE[rule.name] ?? rule.rank,
    number: Number.isNaN(number) ? 0 : number,
    kind: rule.name,
  };
}

/**
 * The rooms in the office's order. Stable: rooms the list ranks the same --
 * two living rooms, two rooms it does not name -- keep the order they came in,
 * which is their walk order wherever the caller read them that way.
 */
export function sortAreasBySequence<T>(areas: readonly T[], nameOf: (area: T) => string): T[] {
  return areas
    .map((area, index) => ({ area, index, key: areaSequenceKey(nameOf(area)) }))
    .sort(
      (a, b) => a.key.rank - b.key.rank || a.key.number - b.key.number || a.index - b.index,
    )
    .map((entry) => entry.area);
}
