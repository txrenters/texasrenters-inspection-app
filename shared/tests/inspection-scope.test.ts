import { describe, expect, it } from 'vitest';

import {
  AreaScope,
  areaScopeFor,
  checklistKindFor,
  inspectionComparesToBaseline,
  inspectionEstablishesBaseline,
  inspectionRequiresAreaRecording,
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
 *   HVAC             the property’s system, as one subject
 *
 * And the off-cycle work added later, none of it a tenancy stage:
 *
 *   roof             every area recorded as a roof
 *   AC filter        the same system as HVAC — a filter is fitted to it
 *   lockbox in/out   selected areas — the box has no fixed subject
 *
 * These assertions are the rules. If one changes, it changes here first.
 */
describe('how an inspection decides which areas it covers', () => {
  it.each([
    [InspectionType.MOVE_IN, AreaScope.ALL],
    [InspectionType.MOVE_OUT, AreaScope.ALL],
    [InspectionType.OCCUPIED, AreaScope.CHOSEN],
    [InspectionType.BACK_TO_MARKET, AreaScope.CHOSEN],
    [InspectionType.HVAC, AreaScope.HVAC_SYSTEM],
    [InspectionType.AC_FILTER_DELIVERY, AreaScope.HVAC_SYSTEM],
    [InspectionType.ROOF, AreaScope.ROOF_AREAS],
    [InspectionType.SUPRA_LOCKBOX_PLACEMENT, AreaScope.CHOSEN],
    [InspectionType.SUPRA_LOCKBOX_REMOVAL, AreaScope.CHOSEN],
  ])('%s covers %s', (type, scope) => {
    expect(areaScopeFor(type)).toBe(scope);
  });

  /**
   * Conservative rather than generous. An unrecognised type asks somebody to
   * say what the visit covers instead of silently claiming the whole property,
   * and it preserves the previous behaviour, where anything that was not a
   * move-in or move-out inspected a subset.
   */
  it.each([undefined, null, '', 'SOMETHING_NEW'])(
    'falls back to a chosen subset for %p',
    (type) => {
      expect(areaScopeFor(type)).toBe(AreaScope.CHOSEN);
    },
  );

  /** The narrow question most call sites ask, kept in step with the taxonomy. */
  it('requires every area for exactly the two lifecycle ends', () => {
    expect(inspectionRequiresEveryArea(InspectionType.MOVE_IN)).toBe(true);
    expect(inspectionRequiresEveryArea(InspectionType.MOVE_OUT)).toBe(true);
    expect(inspectionRequiresEveryArea(InspectionType.OCCUPIED)).toBe(false);
    expect(inspectionRequiresEveryArea(InspectionType.BACK_TO_MARKET)).toBe(false);
    expect(inspectionRequiresEveryArea(InspectionType.HVAC)).toBe(false);
    for (const type of [
      InspectionType.ROOF,
      InspectionType.AC_FILTER_DELIVERY,
      InspectionType.SUPRA_LOCKBOX_PLACEMENT,
      InspectionType.SUPRA_LOCKBOX_REMOVAL,
    ]) {
      expect(inspectionRequiresEveryArea(type)).toBe(false);
    }
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

  /**
   * `inspectionRequiresLifecycleBaseline` used to be asserted here, and was
   * deleted from the source in 246bec8: refusing to schedule a visit for want
   * of a move-in did not stop the visit happening, it only stopped a technician
   * being told about it. A missing move-in belongs in the report, not the
   * scheduler.
   *
   * What that test was really protecting survives on `inspectionComparesToBaseline`,
   * so it is asserted here instead. Off-cycle work sits outside the
   * MOVE_IN -> OCCUPIED -> BACK_TO_MARKET -> MOVE_OUT chain, and a type that
   * leaks into the compared set is handed "No move-in baseline is available" on
   * every area — which reads as a fault in the record rather than a question
   * that does not apply. HVAC is the case that already happened; the rest are
   * the same shape.
   *
   * The companion assertion, that the three tenancy visits do compare, is made
   * above and is not repeated.
   */
  it('is not compared against by any off-cycle visit', () => {
    for (const type of [
      InspectionType.HVAC,
      InspectionType.ROOF,
      InspectionType.AC_FILTER_DELIVERY,
      InspectionType.SUPRA_LOCKBOX_PLACEMENT,
      InspectionType.SUPRA_LOCKBOX_REMOVAL,
    ]) {
      expect(inspectionComparesToBaseline(type)).toBe(false);
    }
  });
});

describe('which checklist a visit asks about an area', () => {
  /**
   * Occupied left this list on 2026-09-09, after a technician walked one in the
   * field. It is in the tenancy chain and it does walk ordinary rooms, so it
   * belonged here on every reading except the one that matters: what it asks.
   * A periodic look around somebody's home was being handed the full move-out
   * evaluation of every component in every room. See `occupied-checklist.ts`.
   */
  it('asks the room checklist for the tenancy visits that evaluate components', () => {
    for (const type of [
      InspectionType.MOVE_IN,
      InspectionType.BACK_TO_MARKET,
      InspectionType.MOVE_OUT,
    ]) {
      expect(checklistKindFor(type)).toBe('ROOM');
    }
  });

  it('asks the short list on an occupied visit', () => {
    expect(checklistKindFor(InspectionType.OCCUPIED)).toBe('OCCUPIED');
  });

  it('asks the equipment checklist when servicing an air conditioner', () => {
    expect(checklistKindFor(InspectionType.HVAC)).toBe('AIR_CONDITIONING');
  });

  /**
   * Nothing to score. A lockbox is fitted or it is not and a filter is
   * delivered or it is not — the evidence is the answer. Left to the default,
   * these would have been handed the room checklist, which is the original
   * HVAC bug in a new costume.
   */
  it('asks nothing on a visit whose evidence is the answer', () => {
    for (const type of [
      InspectionType.ROOF,
      InspectionType.AC_FILTER_DELIVERY,
      InspectionType.SUPRA_LOCKBOX_PLACEMENT,
      InspectionType.SUPRA_LOCKBOX_REMOVAL,
    ]) {
      expect(checklistKindFor(type)).toBe('NONE');
    }
  });

  it('still asks the room checklist for an unrecognised type', () => {
    expect(checklistKindFor('SOMETHING_NEW')).toBe('ROOM');
  });
});

describe('which visits owe a video walkthrough of every area', () => {
  /**
   * The rule that was stated on the handset and not on the server. #148 taught
   * the completion gate that an occupied area needs a photograph *or* a
   * recording; `completeRoom` went on demanding an uploaded video for every
   * type, so Mark Complete looked enabled and the request behind it answered
   * 409. Both sides read this function now.
   */
  it('excuses only an occupied inspection', () => {
    expect(inspectionRequiresAreaRecording(InspectionType.OCCUPIED)).toBe(false);
  });

  it.each([
    [InspectionType.MOVE_IN],
    [InspectionType.MOVE_OUT],
    [InspectionType.BACK_TO_MARKET],
    [InspectionType.HVAC],
  ])('still requires one on %s', (type) => {
    // A move-in and a move-out are the condition record a comparison is built
    // from, and the walkthrough is the evidence. Photographs do not replace it.
    expect(inspectionRequiresAreaRecording(type)).toBe(true);
  });

  it('requires one for an unrecognised type', () => {
    // The safe direction: a type nobody has taught this rule asks for the
    // stronger evidence, not the weaker.
    expect(inspectionRequiresAreaRecording('SOMETHING_NEW')).toBe(true);
    expect(inspectionRequiresAreaRecording(null)).toBe(true);
  });
});
