import { InspectionType } from '@prisma/client';
import {
  AreaScope,
  areaScopeFor,
  inspectionRequiresEveryArea,
  inspectionSeedsStandardLayout,
} from '@texasrenters/shared';

/**
 * Which visits a property with no recorded rooms can still be booked for.
 *
 * `NO_APPROVED_AREAS` refused every one of them — "Upload or define the
 * property floor plan and approve its areas before creating an inspection" —
 * at 147 of the 588 active properties, which have no room recorded from any
 * source. The office (2026-09-22) chose the template over the refusal: "let's
 * create a template first ... so this blocker will be fixed", and then, told
 * what it costs a move-in at a one-bedroom property, "moses will skip them".
 *
 * This is the rule the API refuses on and the console disables its button on,
 * so the two cannot drift into disagreeing about what is bookable.
 */
describe('a visit at a property with no rooms', () => {
  it('is given the standard layout when it walks rooms', () => {
    for (const type of [
      InspectionType.OCCUPIED,
      InspectionType.BACK_TO_MARKET,
      InspectionType.MOVE_IN,
      InspectionType.MOVE_OUT,
    ])
      expect(inspectionSeedsStandardLayout(type)).toBe(true);
  });

  /**
   * A roof inspection covers areas *recorded as a roof* and the template
   * records none, so seeding it would be a scheduling success that reaches the
   * technician as an empty job. An HVAC visit never wanted rooms at all and is
   * exempt from the gate by a different branch.
   */
  it('is not given one when a guess cannot answer the question', () => {
    expect(inspectionSeedsStandardLayout(InspectionType.ROOF)).toBe(false);
    expect(inspectionSeedsStandardLayout(InspectionType.HVAC)).toBe(false);
    expect(areaScopeFor(InspectionType.HVAC)).toBe(AreaScope.HVAC_SYSTEM);
  });

  it('is not given one for a type nobody recognises', () => {
    expect(inspectionSeedsStandardLayout(null)).toBe(true);
    expect(areaScopeFor(null)).toBe(AreaScope.CHOSEN);
  });

  /**
   * The cost, stated as a test rather than only in a comment.
   *
   * A move-in and a move-out make every attached area mandatory, so the rooms
   * the template guesses at — Bedroom 3 at a one-bedroom property — have to be
   * skipped one at a time. If this ever becomes false, the trade the office
   * accepted has changed and the comments explaining it are stale.
   */
  it('makes every seeded room mandatory on a move-in or move-out', () => {
    expect(inspectionRequiresEveryArea(InspectionType.MOVE_IN)).toBe(true);
    expect(inspectionRequiresEveryArea(InspectionType.MOVE_OUT)).toBe(true);
    expect(inspectionRequiresEveryArea(InspectionType.OCCUPIED)).toBe(false);
  });
});
