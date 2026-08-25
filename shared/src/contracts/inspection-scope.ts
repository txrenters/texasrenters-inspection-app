import { InspectionType } from '../enums/index.js';

/**
 * Which areas an inspection covers, and how that set is arrived at.
 *
 * The five inspection types answer this in three different ways, and the code
 * previously only knew about two of them:
 *
 *   move-in, move-out      every approved area, no choice offered
 *   occupied, back-to-market   whichever areas the office picked
 *   HVAC                   every area recorded as having an air conditioner
 *
 * That third one is the reason this exists. HVAC was being treated as a chosen
 * subset, so scheduling one meant an operator ticking areas by hand and hoping
 * they remembered which rooms have units in them.
 */
export const AreaScope = {
  /**
   * Every approved area of the property, overriding `PropertyArea.isRequired`.
   *
   * Move-in and move-out are the two the tenancy is judged against, and a
   * move-out is compared area by area to its move-in. An area missing from
   * either end has no counterpart, and the comparison drops it silently rather
   * than reporting a gap - so neither end is allowed to be partial.
   */
  ALL: 'ALL',
  /**
   * Whatever the office selected when scheduling. The per-area `isRequired`
   * flag still applies within that selection.
   */
  CHOSEN: 'CHOSEN',
  /**
   * Every approved area with `hasAirConditioning`. Not a selection: the
   * equipment decides, so the office cannot forget a room and cannot send a
   * technician to look for a unit that was never there.
   */
  AIR_CONDITIONED: 'AIR_CONDITIONED',
  /**
   * Every approved area recorded as a roof. The same idea as
   * `AIR_CONDITIONED`, against `PropertyArea.category` rather than a boolean:
   * the property says where its roof is, so scheduling a roof inspection is
   * not an operator remembering to tick something.
   *
   * A property with no roof area recorded inspects nothing, and creation
   * refuses rather than producing an empty visit — the same safe direction
   * `hasAirConditioning` takes by defaulting to false.
   */
  ROOF_AREAS: 'ROOF_AREAS',
} as const;

export type AreaScope = (typeof AreaScope)[keyof typeof AreaScope];

/**
 * How this kind of visit decides which areas it covers.
 *
 * An unrecognised type falls to `CHOSEN`, which is the conservative answer: it
 * requires somebody to say what the visit covers rather than silently claiming
 * the whole property. It also preserves the previous behaviour, where anything
 * that was not a move-in or move-out inspected a subset.
 */
export function areaScopeFor(inspectionType: string | null | undefined): AreaScope {
  switch (inspectionType) {
    case InspectionType.MOVE_IN:
    case InspectionType.MOVE_OUT:
      return AreaScope.ALL;
    case InspectionType.HVAC:
    // A filter is fitted to the unit, so the visit covers exactly the areas an
    // HVAC inspection would — no separate rule to keep in step.
    case InspectionType.AC_FILTER_DELIVERY:
      return AreaScope.AIR_CONDITIONED;
    case InspectionType.ROOF:
      return AreaScope.ROOF_AREAS;
    default:
      return AreaScope.CHOSEN;
  }
}

/**
 * Whether every area attached to an inspection must be walked.
 *
 * Kept as the narrow question most call sites actually ask, so the completion
 * gate and the progress counters do not each have to know the whole taxonomy.
 * For a move-in or move-out the type overrides `PropertyArea.isRequired`: a
 * garage or patio flagged optional on the property is still mandatory here.
 */
export function inspectionRequiresEveryArea(inspectionType: string | null | undefined): boolean {
  return areaScopeFor(inspectionType) === AreaScope.ALL;
}

/**
 * Whether this visit has to be preceded by a completed move-in.
 *
 * Occupied, back-to-market and move-out are all read against the condition the
 * move-in recorded, so scheduling one without that baseline produces a report
 * with nothing to compare to. Everything else stands on its own: a move-in is
 * the baseline, and the off-cycle visits never look at one.
 *
 * Named rather than left as a pair of literals in the scheduler, because that
 * is where it kept being got wrong — every type added since has had to be
 * remembered there, and forgetting means the new type is refused on any
 * property that has never had a move-in.
 */
export function inspectionRequiresLifecycleBaseline(
  inspectionType: string | null | undefined,
): boolean {
  return inspectionComparesToBaseline(inspectionType);
}

/**
 * Which set of checklist items this visit asks about an area.
 *
 * Both sets are persisted against the same area and only one is asked at a
 * time. Getting this wrong is the original bug: a technician servicing an air
 * conditioner was asked about the floor coverings, because the area's only
 * checklist was the room one written for the move-in.
 */
export function checklistKindFor(
  inspectionType: string | null | undefined,
): 'ROOM' | 'AIR_CONDITIONING' | 'NONE' {
  switch (inspectionType) {
    // Nothing to score. A lockbox is placed or it is not, and a filter is
    // delivered or it is not; the evidence is the answer. Asking the room
    // checklist here would be the original bug in a new costume — a technician
    // fitting a lockbox asked whether the floor coverings are clean.
    case InspectionType.SUPRA_LOCKBOX_PLACEMENT:
    case InspectionType.SUPRA_LOCKBOX_REMOVAL:
    case InspectionType.AC_FILTER_DELIVERY:
    case InspectionType.ROOF:
      return 'NONE';
    default:
      return areaScopeFor(inspectionType) === AreaScope.AIR_CONDITIONED
        ? 'AIR_CONDITIONING'
        : 'ROOM';
  }
}

/**
 * Whether this inspection is the one that records the condition others are
 * later compared against.
 *
 * Only a move-in. It has no baseline of its own to show a technician, because
 * it *is* the baseline.
 */
export function inspectionEstablishesBaseline(inspectionType: string | null | undefined): boolean {
  return inspectionType === InspectionType.MOVE_IN;
}

/**
 * Whether a technician should be shown the move-in condition of an area.
 *
 * The tenancy chain compares back to the move-in, so occupied, back-to-market
 * and move-out all want it. Move-in does not - it establishes the thing. HVAC
 * does not either, and that is the case worth naming: it sits outside the
 * MOVE_IN -> OCCUPIED -> BACK_TO_MARKET -> MOVE_OUT chain entirely, so it was
 * being handed "No move-in baseline is available" on every area. That reads as
 * a fault in the record rather than what it is, which is a question that does
 * not apply to servicing an air conditioner.
 */
export function inspectionComparesToBaseline(inspectionType: string | null | undefined): boolean {
  switch (inspectionType) {
    case InspectionType.OCCUPIED:
    case InspectionType.BACK_TO_MARKET:
    case InspectionType.MOVE_OUT:
      return true;
    default:
      return false;
  }
}
