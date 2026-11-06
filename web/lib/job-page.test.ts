import { describe, expect, it } from 'vitest';

import { reviewComesFirst, visitCanBeEdited } from './job-page';

describe("a visit's title and Details", () => {
  it('can be changed on a Jobber visit only when edits reach Jobber', () => {
    expect(visitCanBeEdited({ scheduledInJobber: true, jobberEditsPushed: true })).toBe(true);
    expect(visitCanBeEdited({ scheduledInJobber: true, jobberEditsPushed: false })).toBe(false);
  });

  it('can be changed on a booking that has not reached Jobber yet', () => {
    expect(visitCanBeEdited({ jobberBooking: { status: 'PENDING' } })).toBe(true);
    expect(visitCanBeEdited({ jobberBooking: { status: 'FAILED' } })).toBe(true);
  });

  it('has nothing to change on a job with no visit, or a booking already sent', () => {
    expect(visitCanBeEdited({})).toBe(false);
    expect(visitCanBeEdited({ jobberBooking: { status: 'SENT' } })).toBe(false);
  });
});

describe('a job page leading with its review', () => {
  it.each(['TECHNICIAN_SUBMITTED', 'PROCESSING', 'REVIEW_REQUIRED', 'UNDER_REVIEW', 'TBD', 'COMPLETED'])(
    'does once a technician has submitted it: %s',
    (status) => {
      expect(reviewComesFirst({ status })).toBe(true);
    },
  );

  it.each(['SCHEDULED', 'IN_PROGRESS', 'FOLLOW_UP_REQUIRED', 'CANCELLED'])(
    'does not while there is nothing to review: %s',
    (status) => {
      expect(reviewComesFirst({ status })).toBe(false);
    },
  );

  it('does not where nobody got in: it was submitted, and nothing was walked', () => {
    expect(
      reviewComesFirst({ status: 'REVIEW_REQUIRED', completionBlockedReason: 'Could not get in: tenant not home' }),
    ).toBe(false);
  });

  it('does where the office held a job back: that says nothing of the walk', () => {
    expect(
      reviewComesFirst({ status: 'TBD', completionBlockedReason: 'Pending administrator determination.' }),
    ).toBe(true);
  });
});
