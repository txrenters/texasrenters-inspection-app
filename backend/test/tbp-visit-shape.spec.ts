import {
  occupiedInspectionInDetails,
  resolveVisitType,
} from '../src/integrations/jobber/jobber.visit-type';
import { visitDetails, visitTitle } from '../src/planning/tbp-plan.service';

const Q4 = { year: 2026, quarter: 4 } as const;

describe('the Jobber visit a quarterly plan will create', () => {
  /**
   * Reproduced from a real one:
   * `19803 Bolton Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package`.
   *
   * Not improved on. Technicians and coordinators have read this shape for as
   * long as the programme has run, and a tidier format would be a change
   * nobody asked for on the one string every person in the workflow sees.
   */
  it('writes the title the office already reads', () => {
    expect(visitTitle({ addressLine1: '19803 Bolton Bridge Ln', zone: 'Zone 1' }, Q4)).toBe(
      '19803 Bolton Bridge Ln - Zone 1 - Q4 2026 Tenant Benefit Package',
    );
  });

  it('leaves the zone segment out rather than writing an empty one', () => {
    expect(visitTitle({ addressLine1: '19803 Bolton Bridge Ln', zone: null }, Q4)).toBe(
      '19803 Bolton Bridge Ln - Q4 2026 Tenant Benefit Package',
    );
  });

  it('names the filters the tenancy actually has', () => {
    expect(visitDetails({ hvacFilterSizes: ['18x36x1', '20x25x1'] })).toBe(
      'Filter Change: 18x36x1 + 20x25x1 + Pest Control + Occupied Inspection',
    );
  });

  it('still asks for a filter change when no size is recorded', () => {
    expect(visitDetails({ hvacFilterSizes: [] })).toBe(
      'Filter Change + Pest Control + Occupied Inspection',
    );
  });
});

/**
 * The round trip, and the most important test in this file.
 *
 * A benefit-package title types as `AC_FILTER_DELIVERY`, which is in
 * `TYPES_NOT_SYNCED` and never becomes an inspection. Only the phrase
 * "Occupied Inspection" in the details line rescues it. So a visit this
 * planner creates is one our own sync would throw away unless the details
 * match what `occupiedInspectionInDetails` looks for — and the failure is
 * silent: the visit exists in Jobber, the technician drives to it, and no
 * inspection ever appears here to record what they found.
 */
describe('a visit we create is one we would import back', () => {
  it('types the generated title as a filter delivery, as the office writes it', () => {
    const resolution = resolveVisitType(visitTitle({ addressLine1: '1 Any St', zone: 'Zone 1' }, Q4));

    expect(resolution).toEqual({ outcome: 'RESOLVED', inspectionType: 'AC_FILTER_DELIVERY' });
  });

  it('rescues it to an occupied inspection through the details line', () => {
    expect(occupiedInspectionInDetails(visitDetails({ hvacFilterSizes: ['18x36x1'] }))).toBe(true);
  });

  it('rescues it even when the tenancy has no filter sizes on record', () => {
    expect(occupiedInspectionInDetails(visitDetails({ hvacFilterSizes: [] }))).toBe(true);
  });
});
