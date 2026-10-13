jest.mock('../src/admin/inspection-creation', () => ({
  resolveInspectionPlan: jest.fn(),
  insertInspection: jest.fn(),
}));

import { InspectionStatus, InspectionType, JobberLinkStatus, JobberOutboundStatus, JobberVisitImportStatus } from '@prisma/client';
import { parseVisitDetails, reportableServices } from '@texasrenters/shared';

import { insertInspection, resolveInspectionPlan } from '../src/admin/inspection-creation';
import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { pairedVisitTypes, resolveVisitType } from '../src/integrations/jobber/jobber.visit-type';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';
import { JobberSyncWorker } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * A Jobber visit that books an HVAC inspection and an occupied inspection is
 * two jobs (the user's decision, 2026-10-13). "<address> - Zone 1 - Q4 Filter
 * Drop+ HVAC Inspection + Occupied inspection" matched both types and was
 * refused as ambiguous, so neither reached the technician. The HVAC inspection
 * holds the visit; the occupied one is its companion and follows it. Ids and
 * addresses invented.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const TITLE = '9 Example St - Zone 1 - Q4 Filter Drop+ HVAC Inspection + Occupied inspection';
const DETAILS = [
  'Filter Change: 20x25x1 + Pest Control + HVAC Inspection + Occupied Inspection',
  '',
  'Call or text tenant prior to arrival',
  'Lockbox code 1234',
].join('\n');

describe('which visits are two jobs', () => {
  it('reads an HVAC and an occupied inspection in one title as both, the HVAC one holding the visit', () => {
    expect(pairedVisitTypes(resolveVisitType(TITLE), null)).toEqual({
      primary: InspectionType.HVAC,
      companion: InspectionType.OCCUPIED,
    });
    // The benefit package beside them is the wrapper, not a third job.
    expect(pairedVisitTypes(resolveVisitType('Q4 TBP - HVAC Inspection + Occupied Inspection'), null)).not.toBeNull();
  });

  it('reads a benefit-package visit whose services line books both', () => {
    expect(pairedVisitTypes(resolveVisitType('Q4 2026 Tenant Benefit Package'), DETAILS)).toEqual({
      primary: InspectionType.HVAC,
      companion: InspectionType.OCCUPIED,
    });
  });

  it('leaves every other pair ambiguous, and the standing completion steps book nothing', () => {
    expect(pairedVisitTypes(resolveVisitType('Move out inspection + lockbox removal'), null)).toBeNull();
    expect(pairedVisitTypes(resolveVisitType('Occupied inspection'), null)).toBeNull();
    // "3. HVAC / Occupied Inspection" is on nearly every benefit-package visit.
    expect(
      pairedVisitTypes(
        resolveVisitType('Q4 2026 Tenant Benefit Package'),
        'Filter Change: 20x25x1 + Pest Control\nCompletion steps:\n3. HVAC / Occupied Inspection',
      ),
    ).toBeNull();
  });
});

const visit = (over: Record<string, unknown> = {}) => ({
  id: 'visit-1',
  title: TITLE,
  instructions: DETAILS,
  startAt: '2026-10-13T14:00:00Z',
  endAt: '2026-10-13T16:00:00Z',
  completedAt: null,
  visitStatus: 'UPCOMING',
  job: { id: 'job-1' },
  property: { id: 'jobber-property-1', address: { street1: '9 Example St' } },
  client: { id: 'client-1', name: 'Tenant' },
  ...over,
});

function importer() {
  const tx = {
    tbpQuarterPlanStop: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    jobberVisitImport: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    inspection: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const mapping = {
    resolveProperty: jest.fn().mockResolvedValue({
      id: 'link-1',
      status: JobberLinkStatus.LINKED,
      propertywareBuildingId: 'building-1',
      propertywareUnitId: null,
      propertywareLeaseId: null,
    }),
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, mapping as never) as unknown as {
    applyAssignment: jest.Mock;
    applyChanges: jest.Mock;
    processVisit: (...args: unknown[]) => Promise<void>;
    applyChangesWithCompanions: (...args: unknown[]) => Promise<void>;
  };
  worker.applyAssignment = jest.fn().mockResolvedValue(undefined);
  const result = { imported: 0, skipped: 0, notSynced: 0, unmatched: 0, alreadyComplete: 0, rejected: 0 };
  return { worker, prisma, tx, result };
}

describe('importing a visit that books two jobs', () => {
  beforeEach(() => {
    (resolveInspectionPlan as jest.Mock).mockReset().mockImplementation(async (_tx, input: { inspectionType: string }) => ({
      inspectionType: input.inspectionType,
      scopedAreas: [],
    }));
    (insertInspection as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce({ id: 'inspection-hvac' })
      .mockResolvedValueOnce({ id: 'inspection-occupied' });
  });

  it('creates the HVAC inspection on the visit and the occupied one beside it, then assigns both', async () => {
    const { worker, prisma, result } = importer();

    await worker.processVisit(ORG, visit(), {}, resolveRules(), result);

    expect((resolveInspectionPlan as jest.Mock).mock.calls.map((call) => call[1].inspectionType)).toEqual([
      InspectionType.HVAC,
      InspectionType.OCCUPIED,
    ]);
    const [first, second] = (insertInspection as jest.Mock).mock.calls.map((call) => call[2]);
    expect(first).toMatchObject({ jobberVisitId: 'visit-1', jobberVisitDetails: DETAILS });
    expect(second).toMatchObject({ jobberVisitId: null, jobberCompanionOfId: 'inspection-hvac', jobberJobId: 'job-1' });
    // The services are answered once, on the HVAC job.
    expect(reportableServices(parseVisitDetails(second.jobberVisitDetails))).toEqual([]);
    expect(second.jobberVisitDetails).toContain('Lockbox code 1234');

    expect(prisma.jobberVisitImport.update).toHaveBeenLastCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ status: JobberVisitImportStatus.IMPORTED, inspectionId: 'inspection-hvac' }),
    });
    expect(worker.applyAssignment.mock.calls.map((call) => call[2])).toEqual(['inspection-hvac', 'inspection-occupied']);
    expect(result.imported).toBe(2);
  });

  /**
   * The office made the first such visit's occupied inspection by hand while
   * the importer refused it (2026-10-13). A pair made beside a hand-made job
   * would put the same work on the technician's phone twice.
   */
  it('makes nothing beside a job already booked here by hand within the week, and says why', async () => {
    const { worker, prisma, result } = importer();
    prisma.inspection.findFirst
      .mockResolvedValueOnce(null) // no inspection carries this visit
      .mockResolvedValueOnce({ inspectionType: InspectionType.OCCUPIED, scheduledAt: new Date('2026-10-14T00:00:00Z') });

    await worker.processVisit(ORG, visit(), {}, resolveRules(), result);

    const guard = prisma.inspection.findFirst.mock.calls[1][0].where;
    expect(guard).toMatchObject({
      organizationId: ORG,
      propertywareBuildingId: 'building-1',
      inspectionType: { in: [InspectionType.HVAC, InspectionType.OCCUPIED] },
      jobberVisitId: null,
      jobberCompanionOfId: null,
      status: { not: InspectionStatus.CANCELLED },
    });
    expect(guard.scheduledAt.gte.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(guard.scheduledAt.lte.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(insertInspection).not.toHaveBeenCalled();
    expect(prisma.jobberVisitImport.update).toHaveBeenLastCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        status: JobberVisitImportStatus.REJECTED,
        failureCode: 'JOBBER_VISIT_BOOKED_BY_HAND',
        failureMessage: expect.stringContaining('An occupied inspection is already booked here for 2026-10-14'),
      }),
    });
  });

  it('creates neither when the second cannot be made, and says why against the visit', async () => {
    const { worker, prisma, result } = importer();
    const { ApplicationError } = jest.requireActual('../src/common/errors');
    (resolveInspectionPlan as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce({ inspectionType: InspectionType.HVAC, scopedAreas: [] })
      .mockRejectedValueOnce(new ApplicationError(409, 'INSPECTION_CLASH', 'An occupied inspection is already booked.'));

    await worker.processVisit(ORG, visit(), {}, resolveRules(), result);

    expect(prisma.jobberVisitImport.update).toHaveBeenLastCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ status: JobberVisitImportStatus.REJECTED, failureCode: 'INSPECTION_CLASH' }),
    });
    expect(worker.applyAssignment).not.toHaveBeenCalled();
  });
});

describe('a visit already imported with two jobs', () => {
  it('applies what Jobber changed to both, the second as the companion it is', async () => {
    const { worker, prisma, result } = importer();
    prisma.inspection.findMany.mockResolvedValue([{ id: 'inspection-occupied' }]);
    worker.applyChanges = jest.fn().mockResolvedValue(undefined);

    await worker.applyChangesWithCompanions(ORG, visit(), 'inspection-hvac', result, {});

    expect(prisma.inspection.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberCompanionOfId: 'inspection-hvac' },
      select: { id: true },
    });
    expect(worker.applyChanges.mock.calls.map((call) => [call[2], call[5]])).toEqual([
      ['inspection-hvac', undefined],
      ['inspection-occupied', { companion: true }],
    ]);
  });
});

describe('telling Jobber the visit is done', () => {
  const build = (openCompanions: number) => {
    const request = jest.fn().mockResolvedValue({ visitComplete: { userErrors: [] } });
    const prisma = {
      inspection: {
        findUnique: jest.fn().mockResolvedValue({ finalizedAt: null }),
        count: jest.fn().mockResolvedValue(openCompanions),
      },
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            inspectionId: 'inspection-hvac',
            jobberVisitId: 'visit-1',
            jobberJobId: 'job-1',
            createdById: null,
            attempts: 2,
            kind: 'VISIT_COMPLETED',
            nextAttemptAt: new Date(),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const previous = { ...process.env };
    Object.assign(process.env, {
      JOBBER_CLIENT_ID: 'client-id',
      JOBBER_CLIENT_SECRET: 'client-secret',
      JOBBER_API_VERSION: '2025-01-20',
      JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
      JOBBER_PUSH_REPORT_LINK: 'false',
      JOBBER_PUSH_SERVICES_NOTE: 'false',
    });
    const worker = new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient);
    process.env = previous;
    return { worker, prisma, request };
  };

  it('waits while the second job is still to do: nothing sent, and the wait is no failed attempt', async () => {
    const { worker, prisma, request } = build(1);

    await expect(worker.run(ORG)).resolves.toMatchObject({ sent: 0, failed: 0, abandoned: 0 });

    expect(prisma.inspection.count).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        jobberCompanionOfId: 'inspection-hvac',
        status: { notIn: expect.arrayContaining([InspectionStatus.CANCELLED, InspectionStatus.TECHNICIAN_SUBMITTED]) },
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({ status: JobberOutboundStatus.PENDING, attempts: 2 }),
    });
  });

  it('completes the visit once both are in', async () => {
    const { worker, request } = build(0);

    await expect(worker.run(ORG)).resolves.toMatchObject({ sent: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function resolveRules() {
  // The worker's own defaults, as a sync run passes them.
  return jest.requireActual('../src/integrations/jobber/jobber.visit-type').visitTypeRules({});
}
