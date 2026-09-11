import { JobberOutboundKind, TbpPlanStatus, TbpStopStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import type { PrismaService } from '../src/common/prisma.service';
import { TbpPublishService } from '../src/planning/tbp-publish.service';

jest.mock('../src/admin/inspection-creation', () => ({
  resolveInspectionPlan: jest.fn(),
  insertInspection: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const creation = require('../src/admin/inspection-creation') as {
  resolveInspectionPlan: jest.Mock;
  insertInspection: jest.Mock;
};

const USER: AuthenticatedUser = {
  id: 'user-1',
  authUserId: 'auth-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
} as unknown as AuthenticatedUser;

interface StopRow {
  id: string;
  sequence: number;
  scheduledOn: Date | null;
  assignedTechnicianId: string | null;
  propertywareBuildingId: string | null;
  propertywareUnitId: string | null;
  propertywareLeaseId: string | null;
  jobberJobId: string | null;
}

const aStop = (id: string, sequence: number, overrides: Partial<StopRow> = {}): StopRow => ({
  id,
  sequence,
  scheduledOn: new Date('2026-10-05T00:00:00.000Z'),
  assignedTechnicianId: 'tech-1',
  propertywareBuildingId: 'bld-1',
  propertywareUnitId: null,
  propertywareLeaseId: null,
  jobberJobId: 'job-1',
  ...overrides,
});

const build = (
  stops: StopRow[],
  options: { blockedCount?: number; claimed?: number; existingInspectionId?: string | null } = {},
) => {
  const remaining = new Map(stops.map((row) => [row.id, row]));

  const planUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: options.claimed ?? 1 });
  const planUpdate = jest.fn().mockResolvedValue({});
  const stopUpdate = jest.fn(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (data.status && data.status !== TbpStopStatus.PLANNED) remaining.delete(where.id);
      return Promise.resolve({});
    },
  );
  const assignmentCreate = jest.fn().mockResolvedValue({});
  const outboundCreate = jest.fn().mockResolvedValue({});
  const auditCreate = jest.fn().mockResolvedValue({});

  const tx = {
    inspectionAssignment: { create: assignmentCreate },
    jobberOutboundTask: { create: outboundCreate },
    tbpQuarterPlanStop: { update: stopUpdate },
    auditLog: { create: auditCreate },
  };

  const prisma = {
    tbpQuarterPlanStop: {
      count: jest.fn().mockResolvedValue(options.blockedCount ?? 0),
      findMany: jest.fn(({ take }: { take: number }) =>
        Promise.resolve([...remaining.values()].slice(0, take)),
      ),
      update: stopUpdate,
    },
    tbpQuarterPlan: { updateMany: planUpdateMany, update: planUpdate },
    inspection: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.existingInspectionId ? { id: options.existingInspectionId } : null,
        ),
    },
    $transaction: (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;

  return {
    service: new TbpPublishService(prisma),
    planUpdateMany,
    planUpdate,
    stopUpdate,
    assignmentCreate,
    outboundCreate,
    auditCreate,
  };
};

beforeEach(() => {
  creation.resolveInspectionPlan.mockReset().mockResolvedValue({ property: { id: 'bld-1' } });
  creation.insertInspection.mockReset().mockImplementation(() =>
    Promise.resolve({ id: `insp-${creation.insertInspection.mock.calls.length}` }),
  );
});

describe('publishing a reviewed quarter', () => {
  it('creates an inspection, an assignment and a Jobber task for every stop', async () => {
    const { service, assignmentCreate, outboundCreate } = build([aStop('s1', 1), aStop('s2', 2)]);

    const summary = await service.publish(USER, 'plan-1');

    expect(summary).toMatchObject({ published: 2, adopted: 0, failed: 0 });
    expect(summary.status).toBe(TbpPlanStatus.PUBLISHED);
    expect(creation.insertInspection).toHaveBeenCalledTimes(2);
    expect(assignmentCreate).toHaveBeenCalledTimes(2);
    expect(outboundCreate).toHaveBeenCalledTimes(2);
    expect(outboundCreate.mock.calls[0][0].data.kind).toBe(JobberOutboundKind.TBP_VISIT_CREATE);
  });

  /**
   * The publishing coordinator approved a quarter; they did not choose this
   * property, this day or this technician. Naming them as the creator of four
   * hundred inspections would make the audit trail say something nobody did.
   */
  it('attributes the inspections to nobody, and the approval to the coordinator', async () => {
    const { service, assignmentCreate, auditCreate } = build([aStop('s1', 1)]);

    await service.publish(USER, 'plan-1');

    expect(creation.insertInspection.mock.calls[0][2].createdById).toBeNull();
    expect(assignmentCreate.mock.calls[0][0].data.assignedById).toBeNull();
    // The audit row is where the human belongs.
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      actorUserId: 'user-1',
      action: 'INSPECTION_CREATED_FROM_TBP_PLAN',
    });
  });

  /**
   * A blocked stop is a tenancy nobody will inspect this quarter. Publishing
   * around it makes that invisible — excluding it is a decision with a reason
   * attached, and that is what the coordinator should have to make.
   */
  it('refuses to publish while any stop is still blocked', async () => {
    const { service, planUpdateMany } = build([aStop('s1', 1)], { blockedCount: 3 });

    await expect(service.publish(USER, 'plan-1')).rejects.toMatchObject({
      code: 'PLAN_HAS_BLOCKED_STOPS',
    });
    // And it never claimed the plan, so a second attempt after fixing them works.
    expect(planUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * The conditional update from DRAFT is the lock — there is no general job
   * lock in this system. Two coordinators clicking Publish within a second of
   * each other must not both start creating the same quarter.
   */
  it('refuses when another publisher already claimed the plan', async () => {
    const { service } = build([aStop('s1', 1)], { claimed: 0 });

    await expect(service.publish(USER, 'plan-1')).rejects.toMatchObject({
      code: 'PLAN_NOT_DRAFT',
    });
    expect(creation.insertInspection).not.toHaveBeenCalled();
  });

  it('claims the plan by moving it out of DRAFT, and only from DRAFT', async () => {
    const { service, planUpdateMany } = build([aStop('s1', 1)]);

    await service.publish(USER, 'plan-1');

    expect(planUpdateMany.mock.calls[0][0].where).toMatchObject({
      id: 'plan-1',
      organizationId: 'org-1',
      status: TbpPlanStatus.DRAFT,
    });
    expect(planUpdateMany.mock.calls[0][0].data.status).toBe(TbpPlanStatus.PUBLISHING);
  });

  /**
   * Exactly the half-published case: a previous run created the inspection and
   * died before writing it back onto the stop. The partial unique index refuses
   * the duplicate, and taking ownership of the existing row is the right answer
   * — reporting a failure a coordinator cannot act on is not.
   */
  it('adopts the inspection a previous run already created', async () => {
    const { service, stopUpdate } = build([aStop('s1', 1)], {
      existingInspectionId: 'insp-existing',
    });
    creation.insertInspection.mockRejectedValue(
      new ApplicationError(409, 'DUPLICATE_INSPECTION', 'already scheduled'),
    );

    const summary = await service.publish(USER, 'plan-1');

    expect(summary).toMatchObject({ published: 0, adopted: 1, failed: 0 });
    expect(summary.status).toBe(TbpPlanStatus.PUBLISHED);
    const adopted = stopUpdate.mock.calls.find(
      (call) => call[0].data.inspectionId === 'insp-existing',
    );
    expect(adopted![0].data.status).toBe(TbpStopStatus.PUBLISHED);
  });

  /**
   * A duplicate with nothing to adopt is a real failure. Silently marking the
   * stop published would leave a tenancy with no inspection and nothing saying
   * so.
   */
  it('fails a stop whose duplicate cannot be found', async () => {
    const { service, stopUpdate } = build([aStop('s1', 1)], { existingInspectionId: null });
    creation.insertInspection.mockRejectedValue(
      new ApplicationError(409, 'DUPLICATE_INSPECTION', 'already scheduled'),
    );

    const summary = await service.publish(USER, 'plan-1');

    expect(summary).toMatchObject({ published: 0, failed: 1 });
    expect(summary.status).toBe(TbpPlanStatus.PUBLISH_FAILED);
    expect(stopUpdate.mock.calls[0][0].data.status).toBe(TbpStopStatus.FAILED);
  });

  it('records why a stop failed, on the stop', async () => {
    const { service, stopUpdate } = build([aStop('s1', 1)]);
    creation.resolveInspectionPlan.mockRejectedValue(
      new ApplicationError(409, 'NO_APPROVED_AREAS', 'This property has no approved areas.'),
    );

    await service.publish(USER, 'plan-1');

    expect(stopUpdate.mock.calls[0][0].data).toMatchObject({
      status: TbpStopStatus.FAILED,
      blockedCode: 'NO_APPROVED_AREAS',
      blockedMessage: 'This property has no approved areas.',
    });
  });

  it('fails a stop that was never routed instead of inventing a date', async () => {
    const { service, stopUpdate } = build([aStop('s1', 1, { scheduledOn: null })]);

    const summary = await service.publish(USER, 'plan-1');

    expect(summary.failed).toBe(1);
    expect(creation.insertInspection).not.toHaveBeenCalled();
    expect(stopUpdate.mock.calls[0][0].data.blockedCode).toBe('NOT_ROUTED');
  });

  /**
   * One assignment per stop, keyed to the stop. A resumed publish that reached
   * the same stop twice must not put a technician on it twice.
   */
  it('keys the assignment to the stop so a resume cannot assign twice', async () => {
    const { service, assignmentCreate } = build([aStop('s1', 1)]);

    await service.publish(USER, 'plan-1');

    expect(assignmentCreate.mock.calls[0][0].data.idempotencyKey).toBe('tbp-plan:plan-1:s1');
  });

  it('leaves an unassigned stop without an assignment rather than inventing one', async () => {
    const { service, assignmentCreate } = build([aStop('s1', 1, { assignedTechnicianId: null })]);

    const summary = await service.publish(USER, 'plan-1');

    expect(summary.published).toBe(1);
    expect(assignmentCreate).not.toHaveBeenCalled();
  });
});
