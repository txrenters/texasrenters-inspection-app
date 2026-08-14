import { describe, expect, it } from 'vitest';

import {
  AreaScope,
  areaScopeFor,
  inspectionComparesToBaseline,
  inspectionEstablishesBaseline,
  inspectionRequiresEveryArea,
} from '../src/contracts/inspection-scope.js';
import { InspectionType } from '../src/enums/index.js';

/**
 * The office's rules, stated once, in the order they were given:
 *
 *   move-in          every area, and it becomes the baseline for the move-out
 *   move-out         every area, compared against the move-in
 *   occupied         selected areas
 *   back to market   selected areas
 *   HVAC             every area that has an air conditioner
 *
 * These assertions are the rules. If one changes, it changes here first.
 */
describe('how an inspection decides which areas it covers', () => {
  it.each([
    [InspectionType.MOVE_IN, AreaScope.ALL],
    [InspectionType.MOVE_OUT, AreaScope.ALL],
    [InspectionType.OCCUPIED, AreaScope.CHOSEN],
    [InspectionType.BACK_TO_MARKET, AreaScope.CHOSEN],
    [InspectionType.HVAC, AreaScope.AIR_CONDITIONED],
  ])('%s covers %s', (type, scope) => {
    expect(areaScopeFor(type)).toBe(scope);
  });

  /**
   * Conservative rather than generous. An unrecognised type asks somebody to
   * say what the visit covers instead of silently claiming the whole property,
   * and it preserves the previous behaviour, where anything that was not a
   * move-in or move-out inspected a subset.
   */
  it.each([undefined, null, '', 'SOMETHING_NEW'])('falls back to a chosen subset for %p', (type) => {
    expect(areaScopeFor(type)).toBe(AreaScope.CHOSEN);
  });

  /** The narrow question most call sites ask, kept in step with the taxonomy. */
  it('requires every area for exactly the two lifecycle ends', () => {
    expect(inspectionRequiresEveryArea(InspectionType.MOVE_IN)).toBe(true);
    expect(inspectionRequiresEveryArea(InspectionType.MOVE_OUT)).toBe(true);
    expect(inspectionRequiresEveryArea(InspectionType.OCCUPIED)).toBe(false);
    expect(inspectionRequiresEveryArea(InspectionType.BACK_TO_MARKET)).toBe(false);
    expect(inspectionRequiresEveryArea(InspectionType.HVAC)).toBe(false);
  });

  /**
   * HVAC is not a stricter or looser subset - it is scoped by equipment, so it
   * is neither "all" nor "whatever was picked". Worth asserting directly,
   * because the bug this replaces was HVAC being lumped in with the pickers.
   */
  it('scopes HVAC by equipment, not by selection', () => {
    expect(areaScopeFor(InspectionType.HVAC)).not.toBe(AreaScope.CHOSEN);
    expect(areaScopeFor(InspectionType.HVAC)).not.toBe(AreaScope.ALL);
  });
});

describe('which inspections deal in a move-in baseline', () => {
  it('is established by the move-in and nothing else', () => {
    expect(inspectionEstablishesBaseline(InspectionType.MOVE_IN)).toBe(true);
    for (const type of [
      InspectionType.OCCUPIED,
      InspectionType.BACK_TO_MARKET,
      InspectionType.MOVE_OUT,
      InspectionType.HVAC,
    ]) {
      expect(inspectionEstablishesBaseline(type)).toBe(false);
    }
  });

  it('is compared against by the rest of the tenancy chain', () => {
    expect(inspectionComparesToBaseline(InspectionType.OCCUPIED)).toBe(true);
    expect(inspectionComparesToBaseline(InspectionType.BACK_TO_MARKET)).toBe(true);
    expect(inspectionComparesToBaseline(InspectionType.MOVE_OUT)).toBe(true);
  });

  /**
   * The reported bug. HVAC sits outside the tenancy chain, so every area of an
   * HVAC visit was being told "No move-in baseline is available" - which reads
   * as a fault in the record rather than a question that does not apply to
   * servicing an air conditioner.
   */
  it('is neither established nor compared by an HVAC visit', () => {
    expect(inspectionEstablishesBaseline(InspectionType.HVAC)).toBe(false);
    expect(inspectionComparesToBaseline(InspectionType.HVAC)).toBe(false);
  });

  it('is not compared against by the move-in that creates it', () => {
    expect(inspectionComparesToBaseline(InspectionType.MOVE_IN)).toBe(false);
  });
});
