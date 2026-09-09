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
 * then outside — the same shape as the Nordway report the room checklists are
 * transcribed from, so the two read consistently.
 *
 * The four names the office gave in the feedback are here verbatim. "Main"
 * rather than "Master" because that is the wording they used.
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
  { name: 'Second Bedroom', environment: 'INDOOR', category: 'BEDROOM', isRequired: false },
  { name: 'Second Bathroom', environment: 'INDOOR', category: 'BATHROOM', isRequired: false },
  { name: 'Third Bedroom', environment: 'INDOOR', category: 'BEDROOM', isRequired: false },
  { name: 'Hallway', environment: 'INDOOR', category: 'HALLWAY', isRequired: false },
  { name: 'Laundry', environment: 'INDOOR', category: 'UTILITY', isRequired: false },
  // Semi-outdoor with an explicit GARAGE category. The category has to be set:
  // `checklistTemplateFor` once answered on the environment alone, and a
  // semi-outdoor garage was asked about its lawn and never about its doors.
  { name: 'Garage', environment: 'SEMI_OUTDOOR', category: 'GARAGE', isRequired: false },
  // Outdoor areas take their own checklist rather than extending the indoor
  // base — a lawn has no ceiling.
  { name: 'Exterior', environment: 'OUTDOOR', category: null, isRequired: true },
] as const;

/** Written to `PropertyArea.source`, beside AI_FLOOR_PLAN, MANUAL and TECHNICIAN. */
export const STANDARD_LAYOUT_SOURCE = 'STANDARD_TEMPLATE';

/**
 * What an administrator reads on a generated area.
 *
 * Says where it came from and that it is a guess, so a layout nobody has
 * checked is never mistaken for one somebody surveyed.
 */
export const STANDARD_LAYOUT_NOTE =
  'Added from the standard layout because this property had no approved floor plan. Rename, remove or add areas to match the property.';
