import { InspectionType } from '../enums/index.js';

/**
 * Which areas an inspection covers, and how that set is arrived at.
 *
 * The five inspection types answer this in three different ways, and the code
 * previously only knew about two of them:
 *
 *   move-in, move-out      every approved area, no choice offered
 *   occupied, back-to-market   whichever areas the office picked
 *   HVAC                   the property's system, as a single subject
 *
 * That third one is the reason this exists. HVAC was being treated as a chosen
 * subset, so scheduling one meant an operator ticking areas by hand.
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
   * The property's heating and cooling system, treated as one subject.
   *
   * Not a set of rooms. An HVAC visit is a general inspection of the equipment
   * against a standard checklist — it has no floor plan and no per-room walk,
   * so the technician is never asked to pick or complete areas.
   *
   * This replaced `AIR_CONDITIONED`, which covered every approved area flagged
   * `hasAirConditioning`. That model required an approved floor plan *and*
   * somebody to tick the right rooms on every property, and the flag was set on
   * one area in the entire database — so every HVAC inspection ever created
   * covered nothing and reached the technician empty. A rule that depends on
   * upkeep nobody performs is not a safe default, it is a silent failure.
   *
   * Creation attaches exactly one system-managed area per property, so the
   * evidence, checklist and finding tables keep the area they all require while
   * nothing about it is shown to anybody.
   */
  HVAC_SYSTEM: 'HVAC_SYSTEM',
  /**
   * Every approved area recorded as a roof, against `PropertyArea.category`.
   *
   * A property with no roof area recorded inspects nothing, and creation
   * refuses rather than producing an empty visit.
   *
   * Worth knowing: this is the same shape as the `AIR_CONDITIONED` rule that
   * HVAC just moved off, and it carries the same risk — it depends on somebody
   * classifying areas on every property. Roof inspections are not in use yet,
   * so nothing is broken today, but if they are ever scheduled in volume this
   * will need the same treatment.
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
    // A filter is fitted to the system, so a delivery is scoped exactly as an
    // HVAC inspection is — no separate rule to keep in step. This type is being
    // retired (it is a delivery, not an inspection); until it goes, it rides
    // along rather than growing a rule of its own.
    //
    // The comment sits above both labels rather than between them. `no-fallthrough`
    // permits an empty case but not one whose body is a comment, so the original
    // placement failed lint on every branch, main included, and blocked CI before
    // it reached typecheck or the tests.
    case InspectionType.HVAC:
    case InspectionType.AC_FILTER_DELIVERY:
      return AreaScope.HVAC_SYSTEM;
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
 * Nothing requires a completed move-in any more.
 *
 * `inspectionRequiresLifecycleBaseline` used to live here and was the only
 * caller of `inspectionComparesToBaseline`, which made "compares to a baseline"
 * and "is refused without one" the same answer. They are not the same question,
 * and conflating them meant Jobber scheduling a move-out on a property this app
 * had never seen a move-in for produced no inspection at all — ten of them, two
 * of which were happening that day.
 *
 * Jobber is the scheduling source of record. If the office booked the visit,
 * the visit is real, and refusing to represent it does not stop it happening —
 * it only stops a technician being told about it.
 *
 * `inspectionComparesToBaseline` remains, and still decides which visits are
 * read against a move-in. The comparison resolves its own baseline when it runs
 * and reports its absence when there is none, which is where a missing move-in
 * belongs: in the report, not in the scheduler.
 */

/**
 * Which set of checklist items this visit asks about an area.
 *
 * All three sets are persisted against the same area and only one is asked at a
 * time. Getting this wrong is the original bug: a technician servicing an air
 * conditioner was asked about the floor coverings, because the area's only
 * checklist was the room one written for the move-in.
 *
 * OCCUPIED is the same mistake in a quieter costume, and it survived far longer
 * because the list it was handed is not absurd — merely far too long. A
 * periodic look around an occupied home was asking the full move-out
 * evaluation of every component in every room. See `occupied-checklist.ts`.
 */
export function checklistKindFor(
  inspectionType: string | null | undefined,
): 'ROOM' | 'AIR_CONDITIONING' | 'OCCUPIED' | 'NONE' {
  switch (inspectionType) {
    /**
     * A short assessment of the room, not an evaluation of its components.
     *
     * Only OCCUPIED. Back-to-market is deliberately left on the room list: it
     * is the inspection that decides what has to be made good before the next
     * tenancy, so the detail is the point of it.
     */
    case InspectionType.OCCUPIED:
      return 'OCCUPIED';
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
      return areaScopeFor(inspectionType) === AreaScope.HVAC_SYSTEM
        ? 'AIR_CONDITIONING'
        : 'ROOM';
  }
}

/**
 * Whether every area of this visit owes a video walkthrough.
 *
 * False only for an occupied inspection. These are periodic checks during a
 * tenancy, walked room by room in somebody's home: where a room is plainly
 * fine, a photograph records that as well as a walkthrough does and takes a
 * fraction of the time. Requiring a video regardless is what had technicians
 * filming empty hallways to get past a disabled button. A move-in and a
 * move-out are different — those are the condition record a comparison is built
 * from, and the video is the evidence.
 *
 * "Not obliged to film" is not "may finish an area having recorded nothing".
 * An area with neither a photograph nor a recording is one nobody can show was
 * inspected; skipping it remains the honest way to say there was nothing to
 * capture, and that is unchanged.
 *
 * ── WHY THIS IS IN SHARED ────────────────────────────────────────────────────
 *
 * Because it was written twice and only one copy was changed. The handset's
 * completion gate learned this rule in #148; `completeRoom` on the server kept
 * refusing anything without an uploaded video, for every type. So a technician
 * who photographed a room saw Mark Complete enabled, tapped it, and was
 * answered `409 ROOM_VIDEO_REQUIRED` — a disagreement between two clients of
 * the same rule, which is the one thing a shared contract exists to prevent.
 * Both sides now read this function.
 */
export function inspectionRequiresAreaRecording(
  inspectionType: string | null | undefined,
): boolean {
  return inspectionType !== InspectionType.OCCUPIED;
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
