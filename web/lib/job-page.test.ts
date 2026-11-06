import { describe, expect, it } from 'vitest';

import { reviewComesFirst } from './job-page';

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
