import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InspectionStatus, JobberOutboundKind } from '@prisma/client';

import { inspectionSearchWhere } from '../src/admin/inspection-list-where';
import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';
import { technicianJobSearchWhere } from '../src/technician/technician-job-list';
import { JobberSyncWorker, visitJobNumber, type JobberSyncResult } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * Jobber's job number on each inspection (2026-11-06: "the job numbers also is
 * missing on our inspection app and console"). The sync always read it with
 * the visit and never kept it. Ids and numbers invented.
 */

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
  withdrawn: 0,
  skipped: 0,
  truncated: false,
});

const TITLE = '100 Example Way - Zone 1 - Q4 2026 Tenant Benefit Package';

const visit = (fields: Partial<JobberVisit>): JobberVisit =>
  ({ id: 'visit-1', title: TITLE, startAt: '2026-11-16T06:00:00Z', allDay: true, ...fields }) as JobberVisit;

function workerFor(jobberJobNumber: string | null, held: JobberOutboundKind[] = []) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    jobberOutboundTask: { findMany: jest.fn().mockResolvedValue([]) },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inspection-1',
        status: InspectionStatus.SCHEDULED,
        startedAt: null,
        scheduledAt: new Date('2026-11-16T00:00:00Z'),
        scheduledStartAt: null,
        scheduledEndAt: null,
        jobberVisitTitle: TITLE,
        jobberVisitDetails: null,
        jobberJobNumber,
      }),
      updateMany,
    },
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never) as unknown as {
    applyAssignment: jest.Mock;
    completeFromJobber: jest.Mock;
    heldConsoleEdits: jest.Mock;
    applyChanges: (organizationId: string, visit: JobberVisit, inspectionId: string, result: JobberSyncResult) => Promise<void>;
  };
  worker.applyAssignment = jest.fn().mockResolvedValue(undefined);
  worker.completeFromJobber = jest.fn().mockResolvedValue(undefined);
  worker.heldConsoleEdits = jest.fn().mockResolvedValue(new Set(held));
  const numberWrites = () =>
    updateMany.mock.calls.map(([call]) => call.data).filter((data: Record<string, unknown>) => 'jobberJobNumber' in data);
  return { worker, numberWrites };
}

describe("a visit's job number", () => {
  it('is the job number as text, whether Jobber sends it as a number or a string', () => {
    expect(visitJobNumber({ job: { id: 'job-1', jobNumber: 20625 } })).toBe('20625');
    expect(visitJobNumber({ job: { id: 'job-1', jobNumber: ' 20625 ' } })).toBe('20625');
    expect(visitJobNumber({ job: { id: 'job-1', jobNumber: null } })).toBeNull();
    expect(visitJobNumber({ job: { id: 'job-1', jobNumber: '' } })).toBeNull();
    expect(visitJobNumber({ job: null })).toBeNull();
    expect(visitJobNumber({})).toBeNull();
  });
});

describe('keeping the job number on every pass', () => {
  it('writes it onto an inspection that has none, as for one the console booked', async () => {
    const { worker, numberWrites } = workerFor(null);
    await worker.applyChanges('organization-1', visit({ job: { id: 'job-1', jobNumber: 20625 } }), 'inspection-1', result());
    expect(numberWrites()).toEqual([{ jobberJobNumber: '20625' }]);
  });

  it('writes nothing when it has not changed', async () => {
    const { worker, numberWrites } = workerFor('20625');
    await worker.applyChanges('organization-1', visit({ job: { id: 'job-1', jobNumber: 20625 } }), 'inspection-1', result());
    expect(numberWrites()).toEqual([]);
  });

  it('keeps the stored number when a response carries none', async () => {
    const { worker, numberWrites } = workerFor('20625');
    await worker.applyChanges('organization-1', visit({ job: null }), 'inspection-1', result());
    expect(numberWrites()).toEqual([]);
  });

  it('is not held back by a console edit still on its way to Jobber: nothing here changes it', async () => {
    const { worker, numberWrites } = workerFor(null, [JobberOutboundKind.VISIT_EDIT, JobberOutboundKind.VISIT_ASSIGN]);
    await worker.applyChanges('organization-1', visit({ job: { id: 'job-1', jobNumber: 20625 } }), 'inspection-1', result());
    expect(numberWrites()).toEqual([{ jobberJobNumber: '20625' }]);
  });
});

describe('finding an inspection by its job number', () => {
  it('in the console, whole and with or without "#"', () => {
    for (const typed of ['20625', '#20625'])
      expect(JSON.stringify(inspectionSearchWhere(typed))).toContain('{"jobberJobNumber":"20625"}');
    // Words are still found everywhere else; a street word is no job number.
    expect(JSON.stringify(inspectionSearchWhere('Example'))).not.toContain('jobberJobNumber');
  });

  it("on the technician's phone the same way", () => {
    expect(JSON.stringify(technicianJobSearchWhere('#20625'))).toContain('{"jobberJobNumber":"20625"}');
    expect(JSON.stringify(technicianJobSearchWhere('Example'))).not.toContain('jobberJobNumber');
  });
});

describe('the backfill', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/202611060001_inspection_jobber_job_number/migration.sql'),
    'utf8',
  );

  it("takes each job's number from the latest visit of it the sync kept, asking Jobber nothing", () => {
    expect(sql).toContain('ADD COLUMN "jobberJobNumber" TEXT');
    expect(sql).toMatch(/DISTINCT ON \("organizationId", "jobberJobId"\)/);
    expect(sql).toContain(`"payload" -> 'job' ->> 'jobNumber'`);
    expect(sql).toMatch(/ORDER BY "organizationId", "jobberJobId", "updatedAt" DESC/);
    // Within the organization, matched on the job.
    expect(sql).toMatch(/i\."organizationId" = numbers\."organizationId"\s+AND i\."jobberJobId" = numbers\."jobberJobId"/);
  });
});
