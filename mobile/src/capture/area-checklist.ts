import type { AreaEnvironment, InspectionRoom } from '../domain/models';

export interface ChecklistItem {
  id: string;
  /** Shown to the technician. */
  label: string;
  /**
   * Words that count as having covered this item when spoken.
   *
   * Matching is on these rather than the label because a technician says
   * "the taps are fine", not "plumbing fixtures and taps".
   */
  keywords: string[];
}

/**
 * Mock checklists, keyed off the area's name and environment.
 *
 * Deliberately generated rather than fetched: the real lists will come from the
 * property's inspection template, and nothing in the schema models them yet.
 * Keeping the shape identical to what an API would return means wiring the real
 * source later is a repository change, not a rewrite of the screen.
 */
const KITCHEN: ChecklistItem[] = [
  { id: 'appliances', label: 'Appliances present and working', keywords: ['appliance', 'oven', 'stove', 'fridge', 'refrigerator', 'microwave', 'dishwasher'] },
  { id: 'sink', label: 'Sink, taps and drainage', keywords: ['sink', 'tap', 'faucet', 'drain', 'drainage'] },
  { id: 'counters', label: 'Counters and splashback', keywords: ['counter', 'countertop', 'worktop', 'splashback', 'backsplash'] },
  { id: 'cabinets', label: 'Cabinets and drawers', keywords: ['cabinet', 'cupboard', 'drawer'] },
  { id: 'leaks', label: 'Under-sink leaks or water damage', keywords: ['leak', 'water damage', 'damp', 'mould', 'mold'] },
];

const BATHROOM: ChecklistItem[] = [
  { id: 'toilet', label: 'Toilet condition and flush', keywords: ['toilet', 'flush', 'cistern'] },
  { id: 'shower', label: 'Shower or bath and seals', keywords: ['shower', 'bath', 'tub', 'seal', 'grout', 'silicone'] },
  { id: 'basin', label: 'Basin, taps and drainage', keywords: ['basin', 'sink', 'tap', 'faucet', 'drain'] },
  { id: 'ventilation', label: 'Extractor or ventilation', keywords: ['extractor', 'vent', 'ventilation', 'fan'] },
  { id: 'damp', label: 'Damp, mould or water staining', keywords: ['damp', 'mould', 'mold', 'stain', 'water damage'] },
];

const BEDROOM: ChecklistItem[] = [
  { id: 'walls', label: 'Walls and paintwork', keywords: ['wall', 'paint', 'paintwork', 'scuff', 'mark'] },
  { id: 'flooring', label: 'Flooring condition', keywords: ['floor', 'flooring', 'carpet', 'laminate', 'tile'] },
  { id: 'windows', label: 'Windows, locks and blinds', keywords: ['window', 'lock', 'blind', 'curtain', 'latch'] },
  { id: 'storage', label: 'Wardrobe or storage', keywords: ['wardrobe', 'closet', 'storage', 'shelf'] },
  { id: 'outlets', label: 'Sockets, switches and lighting', keywords: ['socket', 'outlet', 'switch', 'light', 'lighting'] },
];

const EXTERIOR: ChecklistItem[] = [
  { id: 'surfaces', label: 'Walls, render and roofline', keywords: ['wall', 'render', 'brick', 'roof', 'roofline', 'gutter'] },
  { id: 'ground', label: 'Paths, driveway and drainage', keywords: ['path', 'driveway', 'paving', 'drain', 'drainage'] },
  { id: 'boundary', label: 'Fencing, gates and boundary', keywords: ['fence', 'fencing', 'gate', 'boundary', 'wall'] },
  { id: 'vegetation', label: 'Vegetation and overgrowth', keywords: ['grass', 'lawn', 'hedge', 'tree', 'overgrown', 'weed'] },
  { id: 'rubbish', label: 'Rubbish or items left outside', keywords: ['rubbish', 'trash', 'bin', 'debris', 'left behind'] },
];

const GENERAL: ChecklistItem[] = [
  { id: 'walls', label: 'Walls and ceiling', keywords: ['wall', 'ceiling', 'paint', 'crack'] },
  { id: 'flooring', label: 'Flooring condition', keywords: ['floor', 'flooring', 'carpet', 'laminate', 'tile'] },
  { id: 'doors', label: 'Doors, handles and locks', keywords: ['door', 'handle', 'lock', 'hinge'] },
  { id: 'outlets', label: 'Sockets, switches and lighting', keywords: ['socket', 'outlet', 'switch', 'light', 'lighting'] },
  { id: 'damage', label: 'Any visible damage', keywords: ['damage', 'broken', 'crack', 'hole', 'stain'] },
];

/** Ordered most specific first — "master bathroom" must not match the bedroom list. */
const BY_NAME: { test: RegExp; items: ChecklistItem[] }[] = [
  { test: /bath|shower|w\.?c\.?|toilet|ensuite|en-suite/i, items: BATHROOM },
  { test: /kitchen|kitchenette|pantry|utility/i, items: KITCHEN },
  { test: /bed|nursery/i, items: BEDROOM },
];

export function checklistForArea(
  area: Pick<InspectionRoom, 'name'> & { environment?: AreaEnvironment },
): ChecklistItem[] {
  // Outdoors wins over the name: a "garden room" that the plan classifies as
  // OUTDOOR wants the exterior list, not the bedroom one.
  if (area.environment === 'OUTDOOR') return EXTERIOR;
  const matched = BY_NAME.find((entry) => entry.test.test(area.name));
  return matched ? matched.items : GENERAL;
}

/**
 * Which checklist items a piece of speech covers.
 *
 * Kept pure and free of any speech API so the same rule serves both possible
 * sources: live on-device recognition, and the server transcript that already
 * exists for every uploaded recording. Only the caller differs.
 *
 * Returns ids rather than mutating, so the caller decides whether a mention is
 * enough to tick something — a decision that belongs with the technician, not
 * with a keyword table.
 */
export function matchChecklistMentions(items: ChecklistItem[], spoken: string): string[] {
  const haystack = ` ${spoken.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  if (haystack.trim().length === 0) return [];
  return items
    .filter((item) =>
      item.keywords.some((keyword) => {
        const needle = keyword.toLowerCase();
        // Word-boundary padded rather than a bare `includes`: "drain" must not
        // fire on "draining board", and "tap" must never match "tape".
        return haystack.includes(` ${needle} `) || haystack.includes(` ${needle}s `);
      }),
    )
    .map((item) => item.id);
}

/** How much of the list has been covered, for the progress line. */
export function checklistProgress(items: ChecklistItem[], checkedIds: readonly string[]) {
  const known = new Set(items.map((item) => item.id));
  // Counts only ids still on the list: a checklist that changes shape must not
  // report 6 of 5 covered from a stale saved id.
  const covered = new Set(checkedIds.filter((id) => known.has(id)));
  return { covered: covered.size, total: items.length };
}
