import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { moveStopWithVisit } from '../src/planning/move-stop-with-visit';
import { PresenceService } from '../src/realtime/presence.service';
import { ZERO_EVIDENCE } from './support/prisma-evidence';

/**
 * A visit the office moved in the console moves its quarter plan's stop too.
 *
 * The console moved only `Inspection.scheduledAt`. The planner reads a booked
 * visit's day from `TbpQuarterPlanStop.scheduledOn`, so a rebuild compared
 * against the old day. The Jobber sync's own fix (`jobber-reschedule-plan-stop`)
 * never sees this move: the console sends the new day to Jobber, Jobber and the
 * inspection then agree, and the sync has nothing to change. People and ids
 * invented.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-coordinator',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Coordinator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const OCT_2 = new Date('2026-10-02T00:00:00.000Z');
const OCT_5 = new Date('2026-10-05T00:00:00.000Z');
const OCT_9 = new Date('2026-10-09T00:00:00.000Z');

const JOBBER_VISIT = { jobberVisitId: 'visit-9', jobberJobId: 'job-9' };

interface StopState {
  id: string;
  planId: string;
  scheduledOn: Date | null;
  assignedTechnicianId: string | null;
  positionInDay?: number | null;
  driveSecondsForecast?: number | null;
  scheduleOverriddenAt?: Date | null;
  technicianOverriddenAt?: Date | null;
}

const planStop = (overrides: Partial<StopState> = {}): StopState => ({
  id: 'stop-1',
  planId: 'plan-1',
  scheduledOn: OCT_2,
  assignedTechnicianId: 'tech-1',
  positionInDay: 4,
  driveSecondsForecast: 600,
  scheduleOverriddenAt: null,
  technicianOverriddenAt: null,
  ...overrides,
});

/** Only the fields a write sets: Prisma leaves a column alone for `undefined`. */
const written = (data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

/**
 * The console's update against one benefit-package visit and, when there is
 * one, its stop.
 *
 * Stateful, so a second save sees what the first wrote: the edit form sends the
 * date back with every save, and that has to be a real second save rather than
 * an unrelated fixture.
 */
function build({
  inspection: overrides = {},
  stop = null,
}: {
  inspection?: Record<string, unknown>;
  stop?: StopState | null;
} = {}) {
  const inspection: Record<string, unknown> = {
    id: 'inspection-1',
    status: 'SCHEDULED',
    propertywareBuildingId: 'property-1',
    propertywareUnitId: null,
    inspectionType: 'OCCUPIED',
    scheduledAt: OCT_2,
    scheduledStartAt: null,
    scheduledEndAt: null,
    jobberVisitId: 'visit-9',
    ...overrides,
  };
  const tx = {
    inspection: {
      // The reschedule's clash check (`id: { not }`) finds no other booking; the
      // Jobber push's own read (`id`) finds the visit.
      findFirst: jest.fn(async ({ where }: { where: { id: unknown } }) =>
        typeof where.id === 'string' ? JOBBER_VISIT : null,
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(inspection, written(data))),
    },
    tbpQuarterPlanStop: {
      findFirst: jest.fn(async () => (stop ? { ...stop } : null)),
      update: jest.fn(async ({ data }: { data: Partial<StopState> }) => Object.assign(stop!, data)),
    },
    inspectionAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    jobberOutboundTask: {
      upsert: jest.fn().mockResolvedValue({ id: 'task-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    ...ZERO_EVIDENCE,
    inspection: { findFirst: jest.fn(async () => ({ ...inspection })) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const service = new AdminService(prisma as never, new PresenceService());
  const save = (scheduledAt: string, rest: Record<string, unknown> = {}) =>
    service.updateInspection(user, 'inspection-1', { scheduledAt, ...rest });
  return { save, prisma, tx, inspection, stop };
}

const auditOf = (tx: ReturnType<typeof build>['tx']) => tx.auditLog.create.mock.calls[0]![0].data;
const queuedKinds = (tx: ReturnType<typeof build>['tx']) =>
  tx.jobberOutboundTask.upsert.mock.calls.map((call) => call[0].where.organizationId_inspectionId_kind.kind);

describe('a visit the office moved in the console', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    // The console's edits are pushed to Jobber, which is what lets it change a
    // Jobber visit's date at all.
    process.env.JOBBER_BOOKING_ENABLED = 'true';
    delete process.env.JOBBER_PUSH_EDITS_ENABLED;
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('moves its plan stop to the very Date written to the inspection', async () => {
    const { save, tx, inspection, stop } = build({ stop: planStop() });

    await save('2026-10-09T00:00:00.000Z');

    expect(inspection.scheduledAt).toEqual(OCT_9);
    expect(stop!.scheduledOn).toEqual(OCT_9);
    // Not a day worked out again: the rebuild compares the two.
    expect(tx.tbpQuarterPlanStop.update.mock.calls[0]![0].data.scheduledOn).toBe(
      tx.inspection.update.mock.calls[0]![0].data.scheduledAt,
    );
    expect(queuedKinds(tx)).toEqual(['VISIT_RESCHEDULE']);
  });

  it("leaves the old day's order and marks the day and technician as a person's", async () => {
    const { save, tx } = build({ stop: planStop() });

    await save('2026-10-09T00:00:00.000Z');

    expect(tx.tbpQuarterPlanStop.update.mock.calls[0]![0]).toEqual({
      where: { id: 'stop-1' },
      data: {
        scheduledOn: OCT_9,
        positionInDay: null,
        driveSecondsForecast: null,
        scheduleOverriddenAt: expect.any(Date),
        technicianOverriddenAt: expect.any(Date),
      },
    });
  });

  it("looks for the stop only in the coordinator's organization", async () => {
    const { save, tx } = build({ stop: planStop() });

    await save('2026-10-09T00:00:00.000Z');

    expect(tx.tbpQuarterPlanStop.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({ where: { organizationId: user.organizationId, inspectionId: 'inspection-1' } }),
    ]);
  });

  it('records the move on the audit entry of the reschedule it came with', async () => {
    const { save, tx } = build({ stop: planStop() });

    await save('2026-10-09T00:00:00.000Z');

    expect(auditOf(tx)).toMatchObject({
      action: 'INSPECTION_UPDATED',
      metadata: { planStop: { stopId: 'stop-1', planId: 'plan-1', from: '2026-10-02', to: '2026-10-09' } },
    });
  });

  it('moves the stop of a visit not yet in Jobber too, and queues nothing', async () => {
    // Published into the plan but not booked in Jobber: the day is the
    // console's alone to change, and the plan still has to follow it.
    const { save, tx, stop } = build({ inspection: { jobberVisitId: null }, stop: planStop() });

    await save('2026-10-09T00:00:00.000Z');

    expect(stop!.scheduledOn).toEqual(OCT_9);
    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('writes nothing to the stop for the date the edit form sends back with every save', async () => {
    const { save, tx } = build({ stop: planStop() });

    await save('2026-10-02T00:00:00.000Z', { priority: 'HIGH' });

    expect(tx.inspection.update).toHaveBeenCalledTimes(1);
    expect(tx.tbpQuarterPlanStop.findFirst).not.toHaveBeenCalled();
    expect(tx.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
    expect(auditOf(tx).metadata).not.toHaveProperty('planStop');
  });

  it('writes the stop once when the moved visit is saved again', async () => {
    const { save, tx } = build({ stop: planStop() });

    await save('2026-10-09T00:00:00.000Z');
    await save('2026-10-09T00:00:00.000Z', { internalNotes: 'Gate is on the left' });

    expect(tx.inspection.update).toHaveBeenCalledTimes(2);
    expect(tx.tbpQuarterPlanStop.update).toHaveBeenCalledTimes(1);
    expect(queuedKinds(tx)).toEqual(['VISIT_RESCHEDULE']);
  });

  it('does not quietly re-mark a stop that already disagrees when the date is unchanged', async () => {
    // Stale before this fix. Marking it "placed by hand" on a save that changed
    // only a note would take it out of the planner's hands with nothing in the
    // audit to say why. Healing stale stops is a separate backfill's job.
    const { save, tx, stop } = build({ stop: planStop({ scheduledOn: OCT_5 }) });

    await save('2026-10-02T00:00:00.000Z', { internalNotes: 'Gate is on the left' });

    expect(tx.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
    expect(stop!.scheduledOn).toEqual(OCT_5);
  });

  it('reschedules an inspection with no plan stop exactly as before', async () => {
    // A move-in, or any visit the quarter planner never published.
    const { save, tx, inspection } = build({ inspection: { inspectionType: 'MOVE_IN' }, stop: null });

    await save('2026-10-09T00:00:00.000Z');

    expect(inspection.scheduledAt).toEqual(OCT_9);
    expect(tx.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
    expect(auditOf(tx).metadata).not.toHaveProperty('planStop');
    expect(queuedKinds(tx)).toEqual(['VISIT_RESCHEDULE']);
  });
});

describe('moveStopWithVisit', () => {
  const client = (stop: StopState | null) => ({
    tbpQuarterPlanStop: {
      findFirst: jest.fn().mockResolvedValue(stop),
      update: jest.fn().mockResolvedValue({}),
    },
  });

  it('compares the dates the DATE columns keep, not the instants', async () => {
    // The console accepts any ISO timestamp; the inspection's DATE keeps only
    // its UTC date, and the stop read back is at midnight. Same day: no write.
    const tx = client(planStop({ scheduledOn: OCT_9 }));

    await expect(
      moveStopWithVisit(tx as never, 'org-1', 'inspection-1', new Date('2026-10-09T15:00:00.000Z')),
    ).resolves.toBeNull();
    expect(tx.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
  });

  it('gives a day to a stop that had none, and marks only the day when nobody is assigned', async () => {
    const tx = client(planStop({ scheduledOn: null, assignedTechnicianId: null }));

    await expect(moveStopWithVisit(tx as never, 'org-1', 'inspection-1', OCT_9)).resolves.toEqual({
      stopId: 'stop-1',
      planId: 'plan-1',
      from: null,
      to: '2026-10-09',
    });
    const { data } = tx.tbpQuarterPlanStop.update.mock.calls[0]![0];
    expect(data.scheduleOverriddenAt).toEqual(expect.any(Date));
    expect(data).not.toHaveProperty('technicianOverriddenAt');
  });
});
