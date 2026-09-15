import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InspectionStatus } from '@prisma/client';

import { VISIT_BY_ID_QUERY, VISIT_DETAILS_FIELD } from '../src/integrations/jobber/jobber.queries';
import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';
import {
  JobberSyncWorker,
  visitDetailsText,
  type JobberSyncResult,
} from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * The Details a coordinator writes on a Jobber visit, kept on the inspection.
 *
 * They carry what a technician needs for the visit -- filter sizes, the
 * tenant's phone, a gate code, the plan -- and the sync used to read them only
 * to type the visit, then throw them away.
 */

const DETAILS =
  'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\n\nTenant: Jane Q Sample (832) 555-0101';

const result = (): JobberSyncResult => ({
  correlationId: 'c1',
  visitsSeen: 1,
  imported: 0,
  rescheduled: 0,
  unmatched: 0,
  rejected: 0,
  alreadyComplete: 0,
  notSynced: 0,
  assigned: 0,
  completedFromJobber: 0,
  skipped: 0,
  truncated: false,
});

function workerFor(stored: { jobberVisitTitle: string | null; jobberVisitDetails: string | null }) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inspection-1',
        status: InspectionStatus.SCHEDULED,
        startedAt: null,
        scheduledAt: new Date('2026-09-16T00:00:00Z'),
        scheduledStartAt: null,
        scheduledEndAt: null,
        ...stored,
      }),
      updateMany,
    },
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never);
  // Private collaborators stubbed: this is about what happens to the text, not
  // assignment or completion, which have their own specs.
  const internals = worker as unknown as {
    applyAssignment: jest.Mock;
    completeFromJobber: jest.Mock;
    applyChanges: (organizationId: string, visit: JobberVisit, inspectionId: string, result: JobberSyncResult) => Promise<void>;
  };
  internals.applyAssignment = jest.fn().mockResolvedValue(undefined);
  internals.completeFromJobber = jest.fn().mockResolvedValue(undefined);
  return { worker: internals, updateMany };
}

const visit = (fields: Partial<JobberVisit>): JobberVisit =>
  ({ id: 'visit-1', title: '100 Main St - Zone 1 - Q3 2026 Tenant Benefit Package', ...fields }) as JobberVisit;

describe('the Details on an inspection made from a Jobber visit', () => {
  it('keeps them as the coordinator wrote them, and nothing for blank ones', () => {
    expect(visitDetailsText(DETAILS)).toBe(DETAILS);
    expect(visitDetailsText('   \n')).toBeNull();
    expect(visitDetailsText('')).toBeNull();
    expect(visitDetailsText(null)).toBeNull();
    expect(visitDetailsText(undefined)).toBeNull();
  });

  it('updates them when the coordinator edits the visit, even when nothing else moved', async () => {
    const { worker, updateMany } = workerFor({ jobberVisitTitle: visit({}).title ?? null, jobberVisitDetails: 'Filter Change: 20x25x1' });

    await worker.applyChanges('organization-1', visit({ instructions: DETAILS, startAt: null }), 'inspection-1', result());

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'inspection-1', organizationId: 'organization-1' },
      data: { jobberVisitDetails: DETAILS },
    });
  });

  it('updates them before a completed visit returns early', async () => {
    // A gate code added the day before is exactly what a technician needs, and
    // the completion and reschedule branches both return before the end.
    const { worker, updateMany } = workerFor({ jobberVisitTitle: null, jobberVisitDetails: null });

    await worker.applyChanges(
      'organization-1',
      visit({ instructions: DETAILS, visitStatus: 'COMPLETED', completedAt: '2026-09-15T20:00:00Z' }),
      'inspection-1',
      result(),
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'inspection-1', organizationId: 'organization-1' },
      data: { jobberVisitTitle: visit({}).title, jobberVisitDetails: DETAILS },
    });
    expect(worker.completeFromJobber).toHaveBeenCalled();
  });

  it('writes nothing when they have not changed', async () => {
    const { worker, updateMany } = workerFor({ jobberVisitTitle: visit({}).title ?? null, jobberVisitDetails: DETAILS });

    await worker.applyChanges('organization-1', visit({ instructions: DETAILS, startAt: null }), 'inspection-1', result());

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('leaves them alone when the response did not carry the field', async () => {
    // `instructions` absent is a query that did not ask, not a coordinator who
    // deleted what they wrote.
    const { worker, updateMany } = workerFor({ jobberVisitTitle: visit({}).title ?? null, jobberVisitDetails: DETAILS });

    await worker.applyChanges('organization-1', visit({ startAt: null }), 'inspection-1', result());

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('clears them when the coordinator emptied the Details', async () => {
    const { worker, updateMany } = workerFor({ jobberVisitTitle: visit({}).title ?? null, jobberVisitDetails: DETAILS });

    await worker.applyChanges('organization-1', visit({ instructions: '', startAt: null }), 'inspection-1', result());

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { jobberVisitDetails: null } }));
  });

  it('are fetched by the webhook path as well as the paged sync', () => {
    // Without the field a webhook replaced the stored visit with one that had no
    // Details, and typed a benefit-package visit without its occupied phrase.
    expect(VISIT_BY_ID_QUERY).toContain(VISIT_DETAILS_FIELD);
  });

  it('are filled in for existing inspections from the visits the sync already stored', () => {
    const sql = readFileSync(
      join(__dirname, '../prisma/migrations/202609150004_inspection_jobber_visit_details/migration.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ADD COLUMN "jobberVisitTitle" TEXT/);
    expect(sql).toMatch(/ADD COLUMN "jobberVisitDetails" TEXT/);
    // Matched on organization and visit id, never on the visit id alone.
    expect(sql).toMatch(/v\."organizationId" = i\."organizationId"/);
    expect(sql).toMatch(/v\."jobberVisitId" = i\."jobberVisitId"/);
  });
});
