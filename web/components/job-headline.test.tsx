import { render, screen } from '@testing-library/react';
import type { AdminInspection } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { JobHeadline, jobFacts } from './job-headline';

/**
 * What a job is, under its address (the office, 2026-11-06): the job type,
 * occupied or not, TBP or not. Everything invented.
 */

const job = (over: Partial<AdminInspection> = {}) =>
  ({
    id: 'insp-1',
    status: 'SCHEDULED',
    inspectionType: 'OCCUPIED',
    scheduledAt: '2026-11-06T00:00:00.000Z',
    assignments: [],
    tbpVisit: true,
    occupancy: 'OCCUPIED',
    quarter: 'Q4 2026',
    zone: '1',
    tbp: 'ENROLLED',
    jobberJobNumber: '20636',
    jobberVisitDetails: 'Filter Change: 20x30x1 + Pest Control + Occupied Inspection',
    propertywareUnit: null,
    ...over,
  }) as AdminInspection;

describe("a job's headline", () => {
  it('says TBP, occupied, the quarter, the zone and the job number, then what it is for', () => {
    render(<JobHeadline item={job()} />);
    expect(screen.getByTestId('job-facts').textContent).toBe('TBP·Occupied·Q4 2026·Zone 1·Job #20636');
    expect(screen.getByText('AC filter change + Pest control + Occupied inspection')).toBeInTheDocument();
  });

  it('says so when it is not TBP, and leaves out the quarter that only means something there', () => {
    expect(jobFacts(job({ tbpVisit: false, occupancy: 'VACANT', zone: null, jobberJobNumber: null }))).toEqual(['Not TBP', 'Vacant']);
  });

  it('names the unit of a job on one, and says nothing of occupancy it does not know', () => {
    const unit = { id: 'u1', name: 'Unit 2' } as AdminInspection['propertywareUnit'];
    expect(jobFacts(job({ occupancy: null, propertywareUnit: unit }))).toEqual(['TBP', 'Q4 2026', 'Zone 1', 'Job #20636', 'Unit 2']);
  });

  it('says occupancy is as of today, since a done job may have been lived in on the day', () => {
    render(<JobHeadline item={job()} />);
    expect(screen.getByText('Occupied')).toHaveAttribute('title', 'Today, from Propertyware');
  });

  it("warns when the tenant's enrolment disagrees with a TBP visit, and only then", () => {
    const { unmount } = render(<JobHeadline item={job({ tbp: 'NOT_ENROLLED' })} />);
    expect(screen.getByText('The tenant is not enrolled in TBP today.')).toBeInTheDocument();
    unmount();

    for (const over of [{ tbp: 'ENROLLED' }, { tbp: 'NOT_VERIFIED' }, { tbp: null }, { tbpVisit: false, tbp: 'NOT_ENROLLED' }] as const) {
      const { unmount: gone } = render(<JobHeadline item={job(over)} />);
      expect(screen.queryByText('The tenant is not enrolled in TBP today.')).not.toBeInTheDocument();
      gone();
    }
  });
});
