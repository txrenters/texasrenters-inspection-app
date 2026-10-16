import { InspectionStatus, JobberOutboundKind, JobberOutboundStatus, TbpPlanStatus, TbpStopStatus } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { TbpPlanService } from '../src/planning/tbp-plan.service';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

/**
 * Zone 5 is not part of the benefit package (the office, 2026-10-02). On
 * 2026-10-16 a zone-5 visit with no day, refused since September for want of a
 * Jobber property, was queued to be booked again once its property could be
 * matched by its address. Ids and addresses invented.
 */

const NOT_LINKED = 'This property is not linked to a Jobber property.';

const jobberEnvironment = {
  JOBBER_CLIENT_ID: 'client-id',
  JOBBER_CLIENT_SECRET: 'client-secret',
  JOBBER_API_VERSION: '2025-01-20',
  JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
  JOBBER_TBP_WRITE_ENABLED: 'true',
};

const TITLE = '100 Example St - Zone 5 - Q4 2026 Tenant Benefit Package';

const KINDS = [
  ['a visit on a day', JobberOutboundKind.TBP_VISIT_CREATE],
  ['a visit with no day', JobberOutboundKind.TBP_JOB_UNSCHEDULED],
] as const;

/** One booking of `kind` for a plan stop in `zone`, at a property Jobber can book against. */
async function send(kind: JobberOutboundKind, zone: string | null) {
  const stop = {
    status: TbpStopStatus.UNSCHEDULED,
    visitTitle: TITLE,
    visitDetails: 'Filter Change: 20x25x1 + Occupied Inspection',
    scheduledOn: kind === JobberOutboundKind.TBP_VISIT_CREATE ? new Date('2026-10-21T00:00:00.000Z') : null,
    zone,
    propertywareBuildingId: 'building-1',
    propertywareUnitId: null,
    inspectionId: null,
    plan: { quarterYear: 2026, quarterNumber: 4, jobberUnassigned: true },
  };
  const tx = {
    jobberOutboundTask: { update: jest.fn().mockResolvedValue({}) },
    tbpQuarterPlanStop: { update: jest.fn().mockResolvedValue({}) },
    inspection: { update: jest.fn().mockResolvedValue({}) },
    jobberVisitImport: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    jobberOutboundTask: {
      // What is due, then the refused bookings: none.
      findMany: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'task-1',
            kind,
            inspectionId: kind === JobberOutboundKind.TBP_VISIT_CREATE ? 'inspection-1' : null,
            tbpStopId: kind === JobberOutboundKind.TBP_JOB_UNSCHEDULED ? 'stop-1' : null,
            jobberVisitId: null,
            jobberJobId: null,
            createdById: null,
            servicesNoteSentAt: null,
            jobTitle: null,
            attempts: 0,
          },
        ])
        .mockResolvedValueOnce([]),
      findUnique: jest.fn().mockResolvedValue({ jobberJobId: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    tbpQuarterPlanStop: {
      findUnique: jest.fn().mockResolvedValue(stop),
      findFirst: jest.fn().mockResolvedValue(stop),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        status: InspectionStatus.SCHEDULED,
        scheduledAt: new Date('2026-10-21T00:00:00.000Z'),
        jobberVisitId: null,
        jobberVisitTitle: null,
        jobberVisitDetails: null,
        assignments: [],
      }),
    },
    // Its property is linked: only the zone stands in the way.
    $queryRaw: jest
      .fn()
      .mockResolvedValue([
        { jobberPropertyId: 'property-9', jobberAddress: '100 Example St', propertywareUnitId: null, lastUsedAt: null },
      ]),
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const request = jest
    .fn()
    .mockResolvedValueOnce({ jobCreate: { userErrors: [], job: { id: 'job-9' } } })
    .mockResolvedValueOnce({ visitCreate: { userErrors: [], createdVisits: [{ id: 'visit-9' }] } });

  const previous = { ...process.env };
  Object.assign(process.env, jobberEnvironment);
  let worker: JobberOutboundWorker;
  try {
    worker = new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient);
  } finally {
    process.env = previous;
  }
  const outcome = await worker.run('org-1');
  const [marked] = prisma.jobberOutboundTask.update.mock.calls.map(([args]) => args.data).slice(-1);
  return { outcome, request, prisma, marked };
}

describe('a benefit-package visit in a zone the package does not cover', () => {
  it.each(KINDS)('is never booked in Jobber -- %s -- though its property can be', async (_, kind) => {
    const { outcome, request, prisma } = await send(kind, '5');

    expect(request).not.toHaveBeenCalled();
    // Refused before Jobber's properties are even looked at.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ sent: 0, failed: 0, abandoned: 1 });
  });

  it.each(KINDS)('gives up at once -- %s -- saying why, in words a property found later never re-arms', async (_, kind) => {
    const { marked } = await send(kind, 'Zone 5');

    expect(marked).toMatchObject({
      status: JobberOutboundStatus.ABANDONED,
      attempts: 1,
      lastError: 'Zone 5 is not part of the benefit package, so its visits are not booked in Jobber.',
    });
    expect(marked.lastError).not.toBe(NOT_LINKED);
  });

  it.each(KINDS)('books a stop in a covered zone, or with no zone set, as before -- %s', async (_, kind) => {
    for (const zone of ['4', 'Not Set', null]) {
      const { outcome, request } = await send(kind, zone);

      expect(outcome).toMatchObject({ sent: 1, abandoned: 0 });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
});

describe('a quarter rebuilt clears a zone-5 visit with no day that never reached Jobber', () => {
  const build = (unsent: { id: string; zone: string | null }[]) => {
    const deleteMany = jest.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const findMany = jest.fn().mockResolvedValue(unsent);
    const prisma = {
      tbpQuarterPlan: {
        findUnique: jest.fn().mockResolvedValue({ id: 'plan-1', status: TbpPlanStatus.PUBLISHED }),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({ id: 'plan-1', officeDetailsRows: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      // Enrolled, and in zone 5: no longer in the package.
      propertywareTenant: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'tenancy-5', externalId: 'ext-5', zone: '5', tbpEnrollment: 'Yes', building: null }]),
      },
      // No earlier quarter in Jobber to order by.
      $queryRaw: jest.fn().mockResolvedValue([]),
      tbpQuarterPlanStop: { deleteMany, findMany, count: jest.fn().mockResolvedValue(0) },
    };
    return { service: new TbpPlanService(prisma as unknown as PrismaService), deleteMany, findMany };
  };

  const NEVER_SENT = {
    planId: 'plan-1',
    status: TbpStopStatus.UNSCHEDULED,
    inspectionId: null,
    jobberVisitId: null,
    jobberJobId: null,
    // Not even a job made before its visit failed, nor a dated visit being unscheduled.
    jobberTasks: {
      every: { kind: JobberOutboundKind.TBP_JOB_UNSCHEDULED, jobberJobId: null, jobberVisitId: null },
    },
    propertywareTenantId: { notIn: [] },
    // Untouched, as the clean-up of planned visits asks.
    scheduleOverriddenAt: null,
    visitTitleOverriddenAt: null,
    unitOverriddenAt: null,
  };

  it('clears it, and its queued booking with it, and only it', async () => {
    const { service, deleteMany } = build([
      { id: 'stop-zone-5', zone: '5' },
      // Left the package another way -- a switch, an opt-out: not this clean-up's.
      { id: 'stop-zone-3', zone: '3' },
      { id: 'stop-no-zone', zone: null },
    ]);

    await service.generate('org-1', { year: 2026, quarter: 4 });

    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany.mock.calls[1][0].where).toMatchObject({ ...NEVER_SENT, id: { in: ['stop-zone-5'] } });
  });

  it('looks only at visits that never reached Jobber, and were never touched by a coordinator', async () => {
    const { service, findMany } = build([]);

    await service.generate('org-1', { year: 2026, quarter: 4 });

    expect(findMany.mock.calls[0][0]).toMatchObject({ where: NEVER_SENT, select: { id: true, zone: true } });
  });

  it('leaves the clean-up of planned and held-back visits as it was, and deletes nothing more when none is outside', async () => {
    const { service, deleteMany } = build([{ id: 'stop-zone-1', zone: 'Zone 1' }]);

    await service.generate('org-1', { year: 2026, quarter: 4 });

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where).toMatchObject({
      planId: 'plan-1',
      status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED] },
      inspectionId: null,
      jobberVisitId: null,
    });
    expect(deleteMany.mock.calls[0][0].where).not.toHaveProperty('jobberJobId');
  });
});
