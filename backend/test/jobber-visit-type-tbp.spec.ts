import { InspectionType } from '@prisma/client';

import { resolveVisitType } from '../src/integrations/jobber/jobber.visit-type';

/**
 * Three completed Jobber visits called themselves inspections and never
 * reached the console. Found on 2026-09-22 by auditing what the sync had
 * skipped: 1,505 visits seen, 895 imported, and of the rest all but three were
 * correctly left alone.
 *
 * Two of the three were rules that could be fixed. The third could not, and
 * that is recorded here too — "Make a video inspection" names no type any rule
 * can read, and guessing one is how a move-out gets filed as a roof.
 */
describe('typing a Jobber visit from its title', () => {
  /**
   * "5863 Pattern Gate Dr - Zone 2 - Q2 TBP (HVAC Inspection)".
   *
   * `tbp` and `hvac` both matched, so it read as ambiguous and was dropped —
   * a completed HVAC inspection nobody could see. The programme word says
   * which scheme paid for the visit, not what the technician did.
   */
  it('reads the work, not the programme, when a benefit-package visit names one', () => {
    expect(resolveVisitType('5863 Pattern Gate Dr - Zone 2 - Q2 TBP (HVAC Inspection)')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.HVAC,
    });
    expect(resolveVisitType('Q3 2026 Tenant Benefit Package + Occupied Inspection')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.OCCUPIED,
    });
  });

  /** A delivery that names no other work is still a delivery. */
  it('leaves a plain benefit-package visit as the delivery it is', () => {
    expect(resolveVisitType('Q3 TBP Filter Change + Pest Control')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.AC_FILTER_DELIVERY,
    });
  });

  /**
   * Three matches is a title nobody can read confidently. The rule is
   * deliberately narrow: one programme word and one kind of work.
   */
  it('stays ambiguous when the title names two kinds of work', () => {
    const resolution = resolveVisitType('TBP - Move Out and Roof Inspection');

    expect(resolution.outcome).toBe('AMBIGUOUS');
  });

  it('is still ambiguous without any programme word', () => {
    expect(resolveVisitType('Move Out + Roof Inspection').outcome).toBe('AMBIGUOUS');
  });

  /** "21545 Model Elm Dr - Inspect AC - 43901", the office's own wording. */
  it('reads "Inspect AC" as an HVAC visit', () => {
    expect(resolveVisitType('21545 Model Elm Dr - Inspect AC - 43901')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.HVAC,
    });
    expect(resolveVisitType('Inspect A/C unit')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.HVAC,
    });
  });

  /**
   * The one that stays refused. It names an inspection and no type, and the
   * honest answer is that a person has to say which — the sync now records why
   * it was skipped so it can be found, rather than guessing.
   */
  it('refuses a title that names an inspection but no kind of one', () => {
    expect(resolveVisitType('5978 Sampler Point Lane - Make a video inspection')).toEqual({
      outcome: 'UNKNOWN',
    });
  });
});
