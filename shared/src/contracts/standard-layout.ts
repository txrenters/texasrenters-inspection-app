/**
 * The rooms a property is assumed to have when nobody has recorded its layout.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * An inspection's areas are a snapshot of the property's **approved**
 * `PropertyArea` rows. The Jobber sync says the quiet part out loud in its own
 * comment: visits would be "refused outright on a property with no approved
 * plan, which is currently every property in this portfolio."
 *
 * So every occupied inspection reached the technician with no rooms at all, and
 * the technician typed them in — Main Bedroom, Main Bathroom, Second Bedroom,
 * Second Bathroom — at every property, on every visit, inside the fifteen
 * minutes the office allows for the whole walk. That is the first item of the
 * 2026-09-09 field feedback, and it is not a missing feature: the templating
 * mechanism has always been there and had nothing in it.
 *
 * ── WHY A FIXED LIST RATHER THAN A DERIVED ONE ───────────────────────────────
 *
 * `PropertywareUnit` carries `bedrooms` and `bathrooms`, so a per-property list
 * is possible and was considered. A fixed list was chosen deliberately: it
 * works on every property today, including the ones whose counts are null, and
 * it fails in a way a technician can fix in seconds rather than one that is
 * silently wrong.
 *
 * The cost is that a one-bedroom property is offered a second bedroom it does
 * not have. That is what `isRequired: false` below is for — an occupied visit
 * counts only its required areas, so an absent room neither blocks completion
 * nor needs skipping. Deriving the counts later is a straight improvement on
 * this and does not change anything that reads it.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * Not a claim about the property. These rows are written `source:
 * STANDARD_TEMPLATE` and say so in their notes, so an administrator correcting
 * a layout can tell a generated guess from a plan somebody read. Nothing
 * overwrites a layout that already exists.
 */

export interface StandardLayoutArea {
  name: string;
  environment: 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR';
  /**
   * Set explicitly rather than left to the name rules.
   *
   * `checklistTemplateFor` treats a set category as authoritative and only
   * parses the name when the category is unspecific. Naming these here means
   * the generated checklist for "Main Bathroom" cannot drift if the name rules
   * are ever reordered.
   */
  category: string | null;
  /**
   * Whether an occupied visit counts this room toward completion.
   *
   * False for every room a rental might not have. `inspectionRequiresEveryArea`
   * is false for an occupied inspection, so an optional area is offered to the
   * technician and never stands between them and submitting — which is what
   * makes a fixed list safe on a property it does not perfectly describe.
   *
   * Note this flag is *overridden* on a move-in or move-out, where the type
   * makes every attached area mandatory. That is one of the reasons the
   * generator below is not applied to those two: see `ensureStandardLayout`.
   */
  isRequired: boolean;
}

/**
 * A standard single-family rental, in the order a technician walks it.
 *
 * Front door inward, then the bedrooms and bathrooms, then the service rooms,
 * then outside — the same shape as the report the room checklists are
 * transcribed from, so the two read consistently.
 *
 * ── THE NAMES ARE THE OFFICE'S, NOT OURS ─────────────────────────────────────
 *
 * Taken from a real occupied inspection: 14547 Gleaming Rose Dr, walked by
 * Moses Rodriguez on 2026-09-08 under the office's own "Occupied Inspection"
 * template. The first version of this list guessed at half of them, and the
 * guesses were wrong in a way that matters — "Second Bedroom" where the office
 * writes "Bedroom 2", one "Exterior" where the form separates front from rear.
 *
 * Wrong names are not cosmetic here. A report import matches existing areas by
 * **normalised name**, so a template that calls a room something the office
 * does not creates a duplicate rather than filling in the room it meant. Every
 * name below now matches a heading on that report.
 */
export const STANDARD_PROPERTY_LAYOUT: readonly StandardLayoutArea[] = [
  { name: 'Entrance', environment: 'INDOOR', category: null, isRequired: false },
  { name: 'Living Room', environment: 'INDOOR', category: 'LIVING', isRequired: true },
  { name: 'Kitchen', environment: 'INDOOR', category: 'KITCHEN', isRequired: true },
  { name: 'Dining Area', environment: 'INDOOR', category: 'LIVING', isRequired: false },
  { name: 'Main Bedroom', environment: 'INDOOR', category: 'BEDROOM', isRequired: true },
  { name: 'Main Bathroom', environment: 'INDOOR', category: 'BATHROOM', isRequired: true },
  // Optional from here down: a one-bedroom property has none of them, and an
  // area a technician must skip on every visit teaches them to skip areas.
  { name: 'Bedroom 2', environment: 'INDOOR', category: 'BEDROOM', isRequired: false },
  { name: 'Bathroom 2', environment: 'INDOOR', category: 'BATHROOM', isRequired: false },
  { name: 'Bedroom 3', environment: 'INDOOR', category: 'BEDROOM', isRequired: false },
  { name: 'Hallway', environment: 'INDOOR', category: 'HALLWAY', isRequired: false },
  { name: 'Laundry', environment: 'INDOOR', category: 'UTILITY', isRequired: false },
  // Semi-outdoor with an explicit GARAGE category. The category has to be set:
  // `checklistTemplateFor` once answered on the environment alone, and a
  // semi-outdoor garage was asked about its lawn and never about its doors.
  { name: 'Garage/Carport', environment: 'SEMI_OUTDOOR', category: 'GARAGE', isRequired: false },
  /**
   * Where the cutoffs and detectors are recorded.
   *
   * Not a room, and the one entry here that is not obvious from a floor plan.
   * It is on the office's own form — water and gas cutoff locations, the
   * breaker box, the smoke detectors — and it is the section a landlord needs
   * most and a technician is least likely to invent on the spot.
   */
  { name: 'Code & Cut Offs', environment: 'INDOOR', category: null, isRequired: false },
  // Outdoor areas take their own checklist rather than extending the indoor
  // base — a lawn has no ceiling. Front and rear are separate because the form
  // separates them: the front is photographed from the street, the rear covers
  // the fence, patio and pool.
  { name: 'Front Exterior', environment: 'OUTDOOR', category: null, isRequired: true },
  { name: 'Rear Exterior', environment: 'OUTDOOR', category: null, isRequired: false },
] as const;

/** Written to `PropertyArea.source`, beside AI_FLOOR_PLAN, MANUAL and TECHNICIAN. */
export const STANDARD_LAYOUT_SOURCE = 'STANDARD_TEMPLATE';

/**
 * The sources that arrive as a *whole layout* rather than as one more room.
 *
 * A report import and a floor-plan extraction each describe the entire
 * property, so either of them answers the question this template was guessing
 * at. Once one exists, the guess is superseded — see `standardLayoutSuperseded`.
 *
 * MANUAL and TECHNICIAN are deliberately absent, and the distinction is the
 * whole point of this constant. An administrator adding a shed, or a technician
 * adding a hall closet they found on site, is *adding to* whatever layout the
 * property has. Treating either as a replacement would delete twelve rooms from
 * an inspection because somebody recorded a thirteenth.
 */
export const WHOLE_LAYOUT_SOURCES: readonly string[] = ['IMPORTED_REPORT', 'AI_FLOOR_PLAN'];

/**
 * Whether a real layout has arrived and the standard rooms should stand aside.
 *
 * ── THE COLLISION THIS PREVENTS ──────────────────────────────────────────────
 *
 * An occupied visit seeds "Main Bedroom". A move-in report is imported later
 * and creates "Bedroom 1", because `resolveArea` in the import matches existing
 * areas by normalised name and those two do not match. Both are approved, both
 * belong to the property, and nothing removes either — the import's own cleanup
 * deletes `InspectionArea` rows on the inspection it is importing and never
 * touches `PropertyArea`.
 *
 * The next move-out at that property then walks about twenty-five rooms instead
 * of twelve. That is likely rather than theoretical: the move-in backfill will
 * import reports at properties that have had occupied visits by then.
 *
 * ── WHY SUPERSEDE RATHER THAN DELETE ─────────────────────────────────────────
 *
 * The occupied inspection that seeded them still references those rows, so they
 * cannot be deleted — `AREA_IN_USE` exists precisely to stop that, and deleting
 * them would rewrite the record of a visit somebody actually walked. The rows
 * stay, that inspection keeps its history, and only *future* scoping ignores
 * them.
 *
 * All-or-nothing, on purpose. There is no attempt to match "Main Bedroom" to
 * "Bedroom 1" and keep the better name: a guess that survives alongside
 * evidence is the problem being fixed, and a partial merge decided by string
 * similarity is how you get a property with eleven of one and two of the other.
 */
export function standardLayoutSuperseded(
  areas: readonly { source?: string | null }[],
): boolean {
  return areas.some((area) => area.source && WHOLE_LAYOUT_SOURCES.includes(area.source));
}

/**
 * The layout an inspection should actually be built from.
 *
 * Returns everything untouched unless a whole-layout source is present, in
 * which case the standard rooms drop out and the surveyed ones — plus any
 * manual or technician additions, which are additions to *that* layout — remain.
 */
export function layoutAreasFor<T extends { source?: string | null }>(
  areas: readonly T[],
): T[] {
  if (!standardLayoutSuperseded(areas)) return [...areas];
  return areas.filter((area) => area.source !== STANDARD_LAYOUT_SOURCE);
}

/**
 * What an administrator reads on a generated area.
 *
 * Says where it came from and that it is a guess, so a layout nobody has
 * checked is never mistaken for one somebody surveyed.
 */
export const STANDARD_LAYOUT_NOTE =
  'Added from the standard layout because this property had no approved floor plan. Rename, remove or add areas to match the property.';
