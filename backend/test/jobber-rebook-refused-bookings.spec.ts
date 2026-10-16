import { JobberOutboundKind, JobberOutboundStatus } from '@prisma/client';

import { businessDate } from '../src/common/business-day';
import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

/**
 * A booking Jobber refused for want of a property is queued again once the
 * property can be booked (2026-10-16). Ids invented.
 */

const NOT_LINKED = 'This property is not linked to a Jobber property.';

const jobberEnvironment = {
  JOBBER_CLIENT_ID: 'client-id',
  JOBBER_CLIENT_SECRET: 'client-secret',
  JOBBER_API_VERSION: '2025-01-20',
  JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
  JOBBER_BOOKING_ENABLED: 'true',
  JOBBER_TBP_WRITE_ENABLED: 'true',
};

const place = (buildingId: string, unitId: string | null = null) => ({
  propertywareBuildingId: buildingId,
  propertywareUnitId: unitId,
});

const refusedVisit = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  kind: JobberOutboundKind.TBP_VISIT_CREATE,
  inspection: { ...place('inspection-building'), tbpPlanStop: place('stop-building', 'stop-unit') },
  tbpStop: null,
  ...overrides,
});

function build({ refused = [refusedVisit()], linkedBuildings = ['stop-building'] } = {}) {
  const prisma = {
    jobberOutboundTask: {
      // What is due first, then the refused bookings.
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(refused),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // The links of the building asked about; nothing else is found.
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('unitAddressLine1') || sql.includes('DISTINCT ON')) return Promise.resolve([]);
      const building = values.find((value) => typeof value === 'string' && value.includes('building'));
      return Promise.resolve(
        linkedBuildings.includes(building as string)
          ? [{ jobberPropertyId: 'property-9', jobberAddress: '100 Example St', propertywareUnitId: null, lastUsedAt: null }]
          : [],
      );
    }),
  };
  const previous = { ...process.env };
  Object.assign(process.env, jobberEnvironment);
  try {
    const worker = new JobberOutboundWorker(prisma as unknown as PrismaService, { request: jest.fn() } as unknown as JobberClient);
    return { worker, prisma };
  } finally {
    process.env = previous;
  }
}

const buildingsAskedAbout = (prisma: ReturnType<typeof build>['prisma']) =>
  prisma.$queryRaw.mock.calls.flatMap((call) => call.slice(1)).filter((value) => String(value).includes('building'));

describe('a booking refused for want of a Jobber property', () => {
  it('is queued again once its plan stop’s property can be booked', async () => {
    const { worker, prisma } = build();

    await worker.run('org-1');

    expect(buildingsAskedAbout(prisma)).toContain('stop-building');
    expect(prisma.jobberOutboundTask.updateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', status: JobberOutboundStatus.ABANDONED, lastError: NOT_LINKED },
      data: { status: JobberOutboundStatus.PENDING, attempts: 0, lastError: null, nextAttemptAt: expect.any(Date) },
    });
  });

  it('stays abandoned while there is still no property to book against', async () => {
    const { worker, prisma } = build({ linkedBuildings: [] });
    await worker.run('org-1');
    expect(prisma.jobberOutboundTask.updateMany).not.toHaveBeenCalled();
  });

  it('is looked for at the property each kind of booking books at', async () => {
    const { worker, prisma } = build({
      refused: [
        refusedVisit({ id: 'console', kind: JobberOutboundKind.VISIT_CREATE }),
        refusedVisit({ id: 'no-day', kind: JobberOutboundKind.TBP_JOB_UNSCHEDULED, inspection: null, tbpStop: place('unscheduled-building') }),
      ],
      linkedBuildings: ['inspection-building', 'unscheduled-building'],
    });

    await worker.run('org-1');

    expect(buildingsAskedAbout(prisma)).toEqual(expect.arrayContaining(['inspection-building', 'unscheduled-building']));
    expect(prisma.jobberOutboundTask.updateMany.mock.calls.map(([args]) => args.where.id)).toEqual(['console', 'no-day']);
  });

  /**
   * The first run queued a zone-5 visit with no day again (2026-10-16). Zone 5
   * left the package on 2026-10-02; its booking is refused for that now, and a
   * refusal from before is left where it is.
   */
  it('is never queued again for a plan stop in a zone the package does not cover', async () => {
    const { worker, prisma } = build({
      refused: [
        refusedVisit({
          id: 'zone-5-on-a-day',
          inspection: { ...place('inspection-building'), tbpPlanStop: { ...place('stop-building'), zone: '5' } },
        }),
        refusedVisit({
          id: 'zone-5-no-day',
          kind: JobberOutboundKind.TBP_JOB_UNSCHEDULED,
          inspection: null,
          tbpStop: { ...place('unscheduled-building'), zone: 'Zone 5' },
        }),
        refusedVisit({
          id: 'zone-4',
          inspection: { ...place('inspection-building'), tbpPlanStop: { ...place('stop-building'), zone: '4' } },
        }),
      ],
      linkedBuildings: ['stop-building', 'unscheduled-building'],
    });

    await worker.run('org-1');

    expect(prisma.jobberOutboundTask.updateMany.mock.calls.map(([args]) => args.where.id)).toEqual(['zone-4']);
    expect(buildingsAskedAbout(prisma)).not.toContain('unscheduled-building');
  });

  it('asks for the zone of the plan stop each benefit-package booking books at', async () => {
    const { worker, prisma } = build({ refused: [] });

    await worker.run('org-1');

    const { select } = prisma.jobberOutboundTask.findMany.mock.calls[1][0];
    expect(select.tbpStop.select).toMatchObject({ zone: true });
    expect(select.inspection.select.tbpPlanStop.select).toMatchObject({ zone: true });
  });

  it('is asked for only while the visit is still to come, open and unbooked -- or has no day', async () => {
    const { worker, prisma } = build({ refused: [] });

    await worker.run('org-1');

    const { where } = prisma.jobberOutboundTask.findMany.mock.calls[1][0];
    expect(where).toMatchObject({ organizationId: 'org-1', status: JobberOutboundStatus.ABANDONED, lastError: NOT_LINKED });
    expect(where.OR).toEqual([
      {
        kind: { in: [JobberOutboundKind.TBP_VISIT_CREATE, JobberOutboundKind.VISIT_CREATE] },
        inspection: {
          status: 'SCHEDULED',
          jobberVisitId: null,
          scheduledAt: { gte: new Date(`${businessDate()}T00:00:00.000Z`) },
        },
      },
      { kind: JobberOutboundKind.TBP_JOB_UNSCHEDULED, tbpStop: { status: 'UNSCHEDULED', inspectionId: null } },
    ]);
  });

  it('never stops the queue when the look fails', async () => {
    const { worker, prisma } = build();
    prisma.jobberOutboundTask.findMany.mockReset();
    prisma.jobberOutboundTask.findMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('database away'));

    await expect(worker.run('org-1')).resolves.toMatchObject({ processed: 0 });
  });
});
