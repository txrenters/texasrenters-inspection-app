jest.mock('../src/admin/inspection-creation', () => ({
  resolveInspectionPlan: jest.fn(),
  insertInspection: jest.fn(),
}));

import { InspectionStatus, LeaseInspectionOutcome } from '@prisma/client';

import { insertInspection, resolveInspectionPlan } from '../src/admin/inspection-creation';
import { ApplicationError } from '../src/common/errors';
import { LeaseInspectionsController } from '../src/planning/lease-inspections.controller';
import type { LeaseInspectionScheduler } from '../src/planning/lease-inspections.scheduler';
import { LeaseInspectionService } from '../src/planning/lease-inspections.service';

/** Friday 18 September 2026, ten in the morning in Texas. */
const NOW = new Date('2026-09-18T15:00:00Z');

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

const lease = (over: Record<string, unknown> = {}) => ({
  id: 'lease-1',
  buildingId: 'building-1',
  unitId: null,
  leaseName: 'Tenant - Tenant',
  sourceStatus: 'Active',
  isActive: true,
  endDate: date('2026-12-20'),
  scheduledMoveOutDate: null,
  noticeGivenDate: null,
  deactivatedAt: null,
  building: { addressLine1: '1 Main St', city: 'Houston' },
  ...over,
});

/** A row of the lease schedule, with the inspection it booked. */
const row = (over: Record<string, unknown> = {}, inspection: Record<string, unknown> | null = {}) => ({
  id: 'row-1',
  leaseId: 'lease-1',
  inspectionType: 'MOVE_OUT',
  dueOn: date('2026-10-14'),
  scheduledOn: date('2026-10-14'),
  outcome: LeaseInspectionOutcome.SCHEDULED,
  inspectionId: 'inspection-1',
  inspection:
    inspection === null
      ? null
      : { id: 'inspection-1', status: InspectionStatus.SCHEDULED, startedAt: null, scheduledAt: date('2026-10-14'), ...inspection },
  ...over,
});

function build(
  options: {
    leases?: unknown[];
    rows?: unknown[];
    existing?: { id: string; scheduledAt: Date } | null;
    units?: number;
    handlers?: { moveOuts: string | null; moveIns: string | null };
  } = {},
) {
  const handlers = options.handlers ?? { moveOuts: 'moses', moveIns: 'amy' };
  const tx = {
    inspection: { update: jest.fn().mockResolvedValue({}) },
    inspectionAssignment: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ id: 'assignment-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    leaseScheduledInspection: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    propertywareLease: { findMany: jest.fn().mockResolvedValue(options.leases ?? [lease()]) },
    leaseScheduledInspection: {
      findMany: jest.fn().mockResolvedValue(options.rows ?? []),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    technicianPlanningProfile: {
      findFirst: jest.fn(({ where }: { where: { handlesMoveOuts?: boolean } }) => {
        const technicianId = where.handlesMoveOuts ? handlers.moveOuts : handlers.moveIns;
        return Promise.resolve(technicianId ? { technicianId } : null);
      }),
    },
    inspection: { findFirst: jest.fn().mockResolvedValue(options.existing ?? null) },
    propertywareUnit: { count: jest.fn().mockResolvedValue(options.units ?? 0) },
    $transaction: jest.fn((run: (client: unknown) => unknown) => run(tx)),
  };
  return { service: new LeaseInspectionService(prisma as never), prisma, tx };
}

beforeEach(() => {
  jest.mocked(resolveInspectionPlan).mockReset().mockResolvedValue({} as never);
  jest.mocked(insertInspection).mockReset().mockResolvedValue({ id: 'inspection-new' } as never);
});

/** The office (2026-09-18): a move-out sixty days before every lease ends, for Moses. */
describe('booking the move-outs and move-ins the leases call for', () => {
  it('books a move-out sixty days before the lease ends, for whoever handles move-outs', async () => {
    const { service, tx } = build();

    const run = await service.run('org-1', { now: NOW });

    expect(run.counts.BOOK).toBe(1);
    expect(run.changes[0]).toMatchObject({ kind: 'MOVE_OUT', action: 'BOOK', scheduledOn: '2026-10-21', property: { address: '1 Main St' } });
    expect(resolveInspectionPlan).toHaveBeenCalledWith(tx, {
      organizationId: 'org-1',
      buildingId: 'building-1',
      unitId: null,
      leaseId: null,
      inspectionType: 'MOVE_OUT',
      scheduledAt: date('2026-10-21'),
    });
    expect(insertInspection).toHaveBeenCalledWith(
      tx,
      {},
      expect.objectContaining({ createdById: null, status: InspectionStatus.SCHEDULED, internalNotes: expect.stringContaining('Booked from Propertyware') }),
    );
    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ inspectionId: 'inspection-new', technicianId: 'moses', assignedById: null, idempotencyKey: 'lease:lease-1:MOVE_OUT:2026-10-21' }),
    });
    expect(tx.leaseScheduledInspection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ outcome: LeaseInspectionOutcome.SCHEDULED, inspectionId: 'inspection-new' }) }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: null, action: 'INSPECTION_BOOKED_FROM_LEASE', entityId: 'inspection-new' }),
    });
  });

  it('books a move-in twenty-two days after a leaving tenant goes, for whoever handles move-ins', async () => {
    const { service, tx } = build({
      leases: [lease({ sourceStatus: 'Active - Notice Given', noticeGivenDate: date('2026-09-01'), endDate: date('2026-10-31') })],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes.map((change) => `${change.kind} ${change.action} ${change.scheduledOn}`)).toEqual([
      'MOVE_OUT BOOK 2026-09-21',
      'MOVE_IN BOOK 2026-11-23',
    ]);
    expect(tx.inspectionAssignment.create.mock.calls.map((call) => call[0].data.technicianId)).toEqual(['moses', 'amy']);
  });

  it('links a move-out the office already booked near the day, rather than booking a second', async () => {
    const { service, prisma } = build({ existing: { id: 'office-booked', scheduledAt: date('2026-10-19') } });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ action: 'ALREADY_BOOKED', inspectionId: 'office-booked' });
    expect(insertInspection).not.toHaveBeenCalled();
    expect(prisma.leaseScheduledInspection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ outcome: LeaseInspectionOutcome.ALREADY_BOOKED, inspectionId: 'office-booked' }) }),
    );
  });

  it('says so when the building has several units and the lease does not say which', async () => {
    jest.mocked(resolveInspectionPlan).mockRejectedValue(new ApplicationError(422, 'UNIT_REQUIRED', 'Select which unit.'));
    const { service, prisma } = build();

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ action: 'NEEDS_UNIT', detail: expect.stringContaining('several units') });
    expect(prisma.leaseScheduledInspection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ outcome: LeaseInspectionOutcome.NEEDS_UNIT, inspectionId: null }) }),
    );
  });

  it('assigns nobody when nobody is marked as handling the kind, and still books it', async () => {
    const { service, tx } = build({ handlers: { moveOuts: null, moveIns: null } });

    const run = await service.run('org-1', { now: NOW });

    expect(run.counts.BOOK).toBe(1);
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
  });

  it('writes nothing in a dry run, and says what a run would do', async () => {
    const { service, prisma } = build({ units: 3 });

    const run = await service.run('org-1', { now: NOW, dryRun: true });

    expect(run).toMatchObject({ dryRun: true, counts: expect.objectContaining({ NEEDS_UNIT: 1 }) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.leaseScheduledInspection.upsert).not.toHaveBeenCalled();
  });
});

describe('keeping them in step with the leases', () => {
  it('moves the inspection it booked when the lease’s dates move', async () => {
    // Booked for 14 October; the lease now ends 20 December, so its move-out is 21 October.
    const { service, tx } = build({ rows: [row()] });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ action: 'MOVE', scheduledOn: '2026-10-21', inspectionId: 'inspection-1' });
    expect(tx.inspection.update).toHaveBeenCalledWith({ where: { id: 'inspection-1' }, data: { scheduledAt: date('2026-10-21') } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'INSPECTION_MOVED_WITH_LEASE' }) });
  });

  it('leaves alone one that was moved by hand, and notes the lease’s new day', async () => {
    const { service, prisma } = build({ rows: [row({}, { scheduledAt: date('2026-10-16') })] });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { dueOn: date('2026-10-21'), detail: expect.stringContaining('left as it is') },
    });
  });

  it('leaves alone one that has started', async () => {
    const { service, prisma } = build({ rows: [row({}, { startedAt: new Date('2026-09-18T14:00:00Z') })] });

    await service.run('org-1', { now: NOW });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('calls off a move-in when the tenant is no longer leaving', async () => {
    const { service, tx } = build({
      leases: [lease({ endDate: date('2027-06-30') })],
      rows: [
        row({ inspectionType: 'MOVE_IN', dueOn: date('2026-11-22'), scheduledOn: date('2026-11-23') }, { scheduledAt: date('2026-11-23') }),
      ],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ kind: 'MOVE_IN', action: 'CALL_OFF' });
    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
      data: expect.objectContaining({ status: InspectionStatus.CANCELLED, cancellationReason: expect.stringContaining('no longer leaving') }),
    });
    expect(tx.inspectionAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'assignment-1' }, data: expect.objectContaining({ isCurrent: false }) }),
    );
    expect(tx.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ outcome: LeaseInspectionOutcome.CALLED_OFF }),
    });
  });

  it('does not book again a day the office cancelled', async () => {
    const { service, prisma } = build({
      rows: [row({ dueOn: date('2026-10-21'), scheduledOn: date('2026-10-21') }, { status: InspectionStatus.CANCELLED, scheduledAt: date('2026-10-21') })],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([]);
    expect(insertInspection).not.toHaveBeenCalled();
    expect(prisma.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { outcome: LeaseInspectionOutcome.CANCELLED, detail: 'Cancelled in the console.' },
    });
  });

  it('books a move-in when a lease leaves the report unrenewed, and not when it came back under its name', async () => {
    const gone = lease({ id: 'gone', isActive: false, endDate: date('2026-08-31'), deactivatedAt: new Date('2026-09-02T12:00:00Z') });

    const left = await build({ leases: [gone] }).service.run('org-1', { now: NOW });
    expect(left.changes).toEqual([expect.objectContaining({ kind: 'MOVE_IN', action: 'BOOK', scheduledOn: '2026-09-22' })]);

    const renewed = await build({ leases: [gone, lease({ id: 'renewal', endDate: date('2027-08-31') })] }).service.run('org-1', { now: NOW });
    expect(renewed.changes).toEqual([]);
  });
});

describe('running it from the console', () => {
  it('previews unless asked to book', async () => {
    const service = { run: jest.fn().mockResolvedValue({}), list: jest.fn() };
    const controller = new LeaseInspectionsController(service as never, {} as LeaseInspectionScheduler);
    const request = { user: { organizationId: 'org-1' } } as never;

    await controller.run(request, {});
    await controller.run(request, { dryRun: false });

    expect(service.run.mock.calls.map((call) => call[1])).toEqual([{ dryRun: true }, { dryRun: false }]);
  });
});

/** The office (2026-09-18): fourteen overdue move-outs would have landed on one Monday. */
describe('move-outs already past their sixty days', () => {
  it('go three a working day from the next one, soonest lease end first', async () => {
    const overdue = ['2026-10-05', '2026-10-01', '2026-10-09', '2026-10-07'].map((ends, index) =>
      lease({ id: `lease-${index + 1}`, buildingId: `building-${index + 1}`, endDate: date(ends) }),
    );
    const { service } = build({ leases: overdue });

    const run = await service.run('org-1', { now: NOW });

    expect(Object.fromEntries(run.changes.map((change) => [change.leaseId, change.scheduledOn]))).toEqual({
      'lease-2': '2026-09-21',
      'lease-1': '2026-09-21',
      'lease-4': '2026-09-21',
      'lease-3': '2026-09-22',
    });
  });
});
