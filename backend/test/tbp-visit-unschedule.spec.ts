import { InspectionStatus, JobberOutboundKind, TbpPlanStatus, TbpStopStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import { businessDate } from '../src/common/business-day';
import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { TbpUnscheduleService, UNSCHEDULED_IN_CONSOLE } from '../src/planning/tbp-unschedule.service';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

/**
 * A published quarter's visits taken off their days in the console, to be
 * grouped again (the office, 2026-10-15), and Jobber told the same way round:
 * the visit goes to its Unscheduled list on the same job. People, places and
 * ids invented.
 */

jest.mock('../src/common/erase-inspection', () => ({
  eraseInspectionRows: jest.fn().mockResolvedValue({
    areas: 3,
    recordings: 0,
    photos: 0,
    findings: 0,
    unlinkedBaselineOf: 0,
    unlinkedParentOf: 0,
  }),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const erase = require('../src/common/erase-inspection') as { eraseInspectionRows: jest.Mock };

const jobberEnvironment = {
  JOBBER_CLIENT_ID: 'client-id',
  JOBBER_CLIENT_SECRET: 'client-secret',
  JOBBER_API_VERSION: '2025-01-20',
  JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
};

/** Both halves of telling Jobber: a visit may be booked, and one deleted. */
const JOBBER_ON = { JOBBER_TBP_WRITE_ENABLED: 'true', JOBBER_PUSH_EDITS_ENABLED: 'true' };

const withEnvironment = async <T>(overrides: Record<string, string | undefined>, work: () => Promise<T> | T) => {
  const previous = { ...process.env };
  Object.assign(process.env, jobberEnvironment, overrides);
  try {
    return await work();
  } finally {
    process.env = previous;
  }
};

const USER = {
  id: 'coordinator-1',
  authUserId: 'auth-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: ['planning:publish', 'inspections:manage'],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const FAR_DAY = '2099-03-10';
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

const booked = (id: string, overrides: Record<string, unknown> = {}, inspection: Record<string, unknown> = {}) => ({
  id,
  status: TbpStopStatus.PUBLISHED,
  scheduledOn: day(FAR_DAY),
  assignedTechnicianId: 'tech-moses',
  jobberJobId: null,
  tenant: { addressLine1: `${id} Bluebonnet Ln` },
  inspection: {
    id: `inspection-${id}`,
    status: InspectionStatus.SCHEDULED,
    startedAt: null,
    scheduledAt: day(FAR_DAY),
    jobberVisitId: `visit-${id}`,
    jobberJobId: `job-${id}`,
    assignments: [{ technicianId: 'tech-moses' }],
    jobberCompanions: [],
    ...inspection,
  },
  ...overrides,
});

function harness(
  stops: ReturnType<typeof booked>[],
  options: {
    planStatus?: TbpPlanStatus;
    worked?: string[];
    claimed?: number;
    leftOnDay?: { onSiteMinutes: number; inspectionType: string }[];
  } = {},
) {
  const tx = {
    inspection: { updateMany: jest.fn().mockResolvedValue({ count: options.claimed ?? 1 }) },
    jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({}) },
    jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    timeSegment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    tbpQuarterPlanStop: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const worked = (options.worked ?? []).map((inspectionId) => ({ inspectionId }));
  const prisma = {
    tbpQuarterPlan: {
      findFirst: jest.fn().mockResolvedValue({ status: options.planStatus ?? TbpPlanStatus.PUBLISHED }),
      update: jest.fn().mockResolvedValue({}),
    },
    tbpQuarterPlanStop: {
      findMany: jest
        .fn()
        // The visits asked for, then what is left on each day they leave.
        .mockResolvedValueOnce(stops)
        .mockResolvedValue(options.leftOnDay ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(7),
    },
    tbpQuarterPlanDay: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inspectionMedia: { findMany: jest.fn().mockResolvedValue(worked) },
    inspectionPhoto: { findMany: jest.fn().mockResolvedValue([]) },
    inspectionArea: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  };
  const technicianEvents = { publish: jest.fn() };
  const cacheInvalidation = { publish: jest.fn().mockResolvedValue(undefined) };
  const service = new TbpUnscheduleService(
    prisma as unknown as PrismaService,
    technicianEvents as never,
    cacheInvalidation as never,
  );
  return { service, prisma, tx, technicianEvents, cacheInvalidation };
}

beforeEach(() => erase.eraseInspectionRows.mockClear());

describe('unscheduling a published quarter’s visits in the console', () => {
  it('deletes a booked visit’s inspection and sends the visit to Jobber’s Unscheduled list on its job', async () => {
    const { service, tx, prisma } = harness([booked('s1')]);

    const summary = await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: FAR_DAY }));

    expect(summary).toMatchObject({ unscheduled: 1, removed: 0, daysCleared: 0, kept: [] });
    // Claimed under its lock, only while nobody has started it.
    expect(tx.inspection.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'inspection-s1',
      startedAt: null,
      status: InspectionStatus.SCHEDULED,
    });
    expect(erase.eraseInspectionRows).toHaveBeenCalledWith(tx, 'inspection-s1');
    // Jobber is told with the dated visit it is to replace.
    expect(tx.jobberOutboundTask.upsert.mock.calls[0][0].create).toMatchObject({
      tbpStopId: 's1',
      kind: JobberOutboundKind.TBP_VISIT_UNSCHEDULE,
      jobberVisitId: 'visit-s1',
      jobberJobId: 'job-s1',
      createdById: 'coordinator-1',
    });
    // The dated visit is not an inspection any more.
    expect(tx.jobberVisitImport.updateMany.mock.calls[0][0]).toMatchObject({
      where: { jobberVisitId: 'visit-s1' },
      data: { status: 'IGNORED', inspectionId: null, failureCode: UNSCHEDULED_IN_CONSOLE },
    });
    // The stop waits with no day, on its job, for the visit Jobber makes.
    expect(tx.tbpQuarterPlanStop.update.mock.calls[0][0].data).toMatchObject({
      status: TbpStopStatus.UNSCHEDULED,
      inspectionId: null,
      scheduledOn: null,
      assignedTechnicianId: null,
      scheduleOverriddenAt: null,
      technicianOverriddenAt: null,
      jobberVisitId: null,
      jobberJobId: 'job-s1',
    });
    expect(tx.auditLog.create.mock.calls.map(([call]) => call.data.action)).toEqual([
      'INSPECTION_DELETED',
      'TBP_VISIT_UNSCHEDULED',
    ]);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'TBP_PLAN_VISITS_UNSCHEDULED',
      metadata: { from: FAR_DAY, unscheduled: 1 },
    });
  });

  it('puts a visit never sent to Jobber back on the plan, and tells Jobber nothing', async () => {
    const { service, tx } = harness([booked('s1', {}, { jobberVisitId: null, jobberJobId: null })]);

    const summary = await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: FAR_DAY }));

    expect(summary).toMatchObject({ unscheduled: 0, removed: 1 });
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
    expect(tx.tbpQuarterPlanStop.update.mock.calls[0][0].data).toMatchObject({
      status: TbpStopStatus.PLANNED,
      jobberJobId: null,
    });
  });

  it('only takes the day off a visit that was never booked', async () => {
    const notBooked = { ...booked('s2'), status: TbpStopStatus.PLANNED, inspection: null };
    const { service, prisma, tx } = harness([notBooked as never]);

    const summary = await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: FAR_DAY }));

    expect(summary).toMatchObject({ daysCleared: 1, unscheduled: 0 });
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
    expect(prisma.tbpQuarterPlanStop.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['s2'] }, inspectionId: null },
      data: { scheduledOn: null, assignedTechnicianId: null },
    });
  });

  it('leaves work somebody started, recorded or called off where it is, and says why', async () => {
    const { service, tx } = harness(
      [
        booked('started', {}, { startedAt: new Date(), status: InspectionStatus.IN_PROGRESS }),
        booked('recorded'),
        booked('called-off', {}, { status: InspectionStatus.CANCELLED }),
        booked('pair', {}, { jobberCompanions: [{ id: 'companion-1' }] }),
      ],
      { worked: ['inspection-recorded', 'companion-1'] },
    );

    const summary = await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: FAR_DAY }));

    expect(summary.unscheduled).toBe(0);
    expect(summary.kept.map((row) => [row.stopId, row.reason])).toEqual([
      ['started', 'IN_USE'],
      ['recorded', 'IN_USE'],
      ['called-off', 'CANCELLED'],
      ['pair', 'COMPANION_IN_USE'],
    ]);
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a visit a technician started while it was being unscheduled', async () => {
    const { service, tx } = harness([booked('s1')], { claimed: 0 });

    const summary = await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: FAR_DAY }));

    expect(summary).toMatchObject({ unscheduled: 0, kept: [{ stopId: 's1', reason: 'IN_USE' }] });
    expect(erase.eraseInspectionRows).not.toHaveBeenCalled();
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('removes an untouched second job of the same visit with it', async () => {
    const { service } = harness([booked('s1', {}, { jobberCompanions: [{ id: 'companion-1' }] })]);

    await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: FAR_DAY }));

    expect(erase.eraseInspectionRows.mock.calls.map(([, id]) => id)).toEqual(['companion-1', 'inspection-s1']);
  });

  it('refuses, before deleting anything, while Jobber cannot be told', async () => {
    const { service, tx } = harness([booked('s1')]);

    await expect(
      withEnvironment({ JOBBER_TBP_WRITE_ENABLED: 'true', JOBBER_PUSH_EDITS_ENABLED: 'false' }, () =>
        service.unschedule(USER, 'plan-1', { from: FAR_DAY }),
      ),
    ).rejects.toMatchObject({ code: 'JOBBER_EDITS_OFF' });
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a first day already gone, and a quarter in the middle of publishing', async () => {
    await expect(harness([]).service.unschedule(USER, 'plan-1', { from: '2020-01-06' })).rejects.toMatchObject({
      code: 'DATE_PASSED',
    });
    await expect(
      harness([], { planStatus: TbpPlanStatus.PUBLISHING }).service.unschedule(USER, 'plan-1', { from: FAR_DAY }),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_EDITABLE' });
  });

  it('takes the named visits whatever their day', async () => {
    const { service, prisma } = harness([booked('s1')]);

    await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { stopIds: ['s1', 's1'] }));

    expect(prisma.tbpQuarterPlanStop.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ['s1'] } });
  });

  it('tells the technician about a job they could be on their way to, and no other', async () => {
    const today = businessDate();
    const { service, technicianEvents, cacheInvalidation } = harness([
      booked('today', { scheduledOn: day(today) }, { scheduledAt: day(today) }),
      booked('later'),
    ]);

    await withEnvironment(JOBBER_ON, () => service.unschedule(USER, 'plan-1', { from: today }));

    expect(technicianEvents.publish).toHaveBeenCalledTimes(1);
    expect(technicianEvents.publish).toHaveBeenCalledWith(
      'tech-moses',
      'inspection-today',
      'CANCELLED',
      expect.stringContaining('today Bluebonnet Ln'),
    );
    expect(cacheInvalidation.publish).toHaveBeenCalledWith({ type: 'inspection.changed', organizationId: 'org-1' });
  });

  it('removes a day left with nothing on it, and counts again one that keeps visits', async () => {
    const emptied = harness([booked('s1')]);
    await withEnvironment(JOBBER_ON, () => emptied.service.unschedule(USER, 'plan-1', { from: FAR_DAY }));
    expect(emptied.prisma.tbpQuarterPlanDay.deleteMany.mock.calls[0][0].where).toMatchObject({
      planId: 'plan-1',
      technicianId: 'tech-moses',
      date: day(FAR_DAY),
    });

    const kept = harness([booked('s1')], {
      leftOnDay: [
        { onSiteMinutes: 20, inspectionType: 'HVAC' },
        { onSiteMinutes: 30, inspectionType: 'OCCUPIED' },
      ],
    });
    await withEnvironment(JOBBER_ON, () => kept.service.unschedule(USER, 'plan-1', { from: FAR_DAY }));
    expect(kept.prisma.tbpQuarterPlanDay.updateMany.mock.calls[0][0].data).toEqual({
      stopCount: 2,
      onSiteMinutes: 50,
      hvacStopCount: 1,
    });
  });

  it('previews what it would do, changing nothing', async () => {
    const { service, tx } = harness(
      [booked('s1'), booked('s2', { scheduledOn: day('2099-03-12') }, { scheduledAt: day('2099-03-12') }), booked('s3')],
      { worked: ['inspection-s3'] },
    );

    const preview = await withEnvironment({ JOBBER_TBP_WRITE_ENABLED: 'false' }, () =>
      service.preview(USER, 'plan-1', { from: FAR_DAY }),
    );

    expect(preview).toMatchObject({
      booked: 2,
      notBooked: 0,
      kept: [{ stopId: 's3', reason: 'IN_USE' }],
      firstDay: FAR_DAY,
      lastDay: '2099-03-12',
      jobberSwitchedOff: true,
    });
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
  });
});

describe('Jobber told a visit was unscheduled in the console', () => {
  const unscheduleTask = {
    id: 'task-1',
    inspectionId: null,
    tbpStopId: 's1',
    kind: JobberOutboundKind.TBP_VISIT_UNSCHEDULE,
    jobberVisitId: 'visit-dated',
    jobberJobId: 'job-1',
    createdById: 'coordinator-1',
    servicesNoteSentAt: null,
    jobTitle: null,
    attempts: 0,
    nextAttemptAt: new Date('2026-10-15T12:00:00.000Z'),
  };
  const jobVisits = (nodes: { id: string; isComplete: boolean }[], hasNextPage = false) => ({
    job: { visits: { nodes, pageInfo: { hasNextPage } } },
  });

  const build = async (stop: Record<string, unknown>, environment: Record<string, string> = JOBBER_ON) => {
    const prisma = {
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValue([unscheduleTask]),
        update: jest.fn().mockResolvedValue({}),
      },
      tbpQuarterPlanStop: {
        findFirst: jest.fn().mockResolvedValue({
          jobberVisitId: null,
          visitTitle: '12 Bluebonnet Ln - Zone 2 - Q4 2026 Tenant Benefit Package',
          visitDetails: 'Filter Change: 16x25x1 + Pest Control + HVAC Inspection',
          ...stop,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const request = jest.fn();
    const worker = await withEnvironment(
      environment,
      () => new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient),
    );
    return { worker, prisma, request };
  };

  it('gives the job a visit with no day, writes it on the stop, then deletes the dated one', async () => {
    const { worker, prisma, request } = await build({});
    request
      .mockResolvedValueOnce({ visitCreate: { userErrors: [], createdVisits: [{ id: 'visit-unscheduled' }] } })
      .mockResolvedValueOnce(jobVisits([{ id: 'visit-dated', isComplete: false }, { id: 'visit-unscheduled', isComplete: false }]))
      .mockResolvedValueOnce({ visitDelete: { userErrors: [] } });

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1 });

    // The same job, the visit's own words, and no schedule: Jobber's Unscheduled list.
    expect(request.mock.calls[0][1]).toContain('visitCreate');
    expect(request.mock.calls[0][2]).toEqual({
      jobId: 'job-1',
      input: {
        visits: [
          {
            title: '12 Bluebonnet Ln - Zone 2 - Q4 2026 Tenant Benefit Package',
            instructions: 'Filter Change: 16x25x1 + Pest Control + HVAC Inspection',
          },
        ],
      },
    });
    expect(prisma.tbpQuarterPlanStop.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { jobberVisitId: 'visit-unscheduled', jobberJobId: 'job-1' },
    });
    expect(request.mock.calls[2][1]).toContain('visitDelete');
    expect(request.mock.calls[2][2]).toEqual({ visitIds: ['visit-dated'] });
  });

  it('does not make a second visit with no day when a retry finds the first on the stop', async () => {
    const { worker, request } = await build({ jobberVisitId: 'visit-unscheduled' });
    request
      .mockResolvedValueOnce(jobVisits([{ id: 'visit-dated', isComplete: false }]))
      .mockResolvedValueOnce({ visitDelete: { userErrors: [] } });

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(request.mock.calls.map((call) => call[1])).not.toContainEqual(expect.stringContaining('visitCreate'));
    expect(request.mock.calls[1][2]).toEqual({ visitIds: ['visit-dated'] });
  });

  it('deletes nothing that Jobber no longer lists, or that was done there since', async () => {
    const gone = await build({ jobberVisitId: 'visit-unscheduled' });
    gone.request.mockResolvedValueOnce(jobVisits([{ id: 'visit-unscheduled', isComplete: false }]));
    await expect(gone.worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(gone.request).toHaveBeenCalledTimes(1);

    const done = await build({ jobberVisitId: 'visit-unscheduled' });
    done.request.mockResolvedValueOnce(jobVisits([{ id: 'visit-dated', isComplete: true }]));
    await expect(done.worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(done.request).toHaveBeenCalledTimes(1);
  });

  it('waits while either booking or edits are switched off', async () => {
    for (const environment of [
      { JOBBER_TBP_WRITE_ENABLED: 'false', JOBBER_PUSH_EDITS_ENABLED: 'true' },
      { JOBBER_TBP_WRITE_ENABLED: 'true', JOBBER_PUSH_EDITS_ENABLED: 'false' },
    ]) {
      const { worker, prisma } = await build({}, environment);
      prisma.jobberOutboundTask.findMany.mockResolvedValue([]);
      await worker.run('org-1');
      expect(prisma.jobberOutboundTask.findMany.mock.calls[0][0].where.kind.notIn).toContain(
        JobberOutboundKind.TBP_VISIT_UNSCHEDULE,
      );
    }
  });
});
