import { InspectionStatus } from '@prisma/client';

import { movableInspection } from '../src/planning/quarter-planner.service';

/**
 * Which booked visits a rebuild is allowed to move.
 *
 * The office's Q4 came out at 6.5 visits a day across 55 days where the same
 * visits pack into 33 days of twelve for 4% more driving — and collecting that
 * means moving visits that are already booked. 337 of Q4's inspections are
 * eligible and 322 of those are live Jobber visits, so the line this draws is
 * the difference between a rebuild and rewriting somebody's record of work.
 *
 * The rule is whether anybody has acted on the visit yet. A scheduled visit is
 * a promise about a future day, and a promise can be changed. A visit somebody
 * has walked, is reviewing, or cancelled is a record.
 */
describe('a booked visit a rebuild may move', () => {
  const at = (status: InspectionStatus, finalizedAt: Date | null = null) => ({ status, finalizedAt });

  it('moves one nobody has started', () => {
    expect(movableInspection(at(InspectionStatus.SCHEDULED))).toBe(true);
  });

  /** Somebody is standing in the property. Their day is not a suggestion. */
  it('leaves one a technician has begun', () => {
    expect(movableInspection(at(InspectionStatus.IN_PROGRESS))).toBe(false);
  });

  it('leaves one that has been walked', () => {
    expect(movableInspection(at(InspectionStatus.COMPLETED))).toBe(false);
    expect(movableInspection(at(InspectionStatus.TECHNICIAN_SUBMITTED))).toBe(false);
    expect(movableInspection(at(InspectionStatus.REVIEW_REQUIRED))).toBe(false);
  });

  it('leaves one somebody cancelled', () => {
    expect(movableInspection(at(InspectionStatus.CANCELLED))).toBe(false);
  });

  /**
   * The belt to the status's braces. `finalizedAt` is what freezes the
   * evidence, and a finalized visit whose status was somehow still SCHEDULED
   * would be a report already issued and possibly charged against a deposit.
   */
  it('leaves a finalized one whatever its status says', () => {
    expect(movableInspection(at(InspectionStatus.SCHEDULED, new Date()))).toBe(false);
  });
});
