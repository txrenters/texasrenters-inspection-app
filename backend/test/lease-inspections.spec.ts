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

/** Ends Tuesday 20 October: its move-out is Wednesday the 21st, inside the sixty days. */
const lease = (over: Record<string, unknown> = {}) => ({
  id: 'lease-1',
  buildingId: 'building-1',
  unitId: null,
  leaseName: 'Tenant - Tenant',
  sourceStatus: 'Active',
  isActive: true,
  endDate: date('2026-10-20'),
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
      : {
          id: 'inspection-1',
          status: InspectionStatus.SCHEDULED,
          startedAt: null,
          scheduledAt: date('2026-10-14'),
          internalNotes: 'Booked from Propertyware: the tenancy ends Tue, Oct 20, 2026, and its move-out is sixty days before.',
          ...inspection,
        },
  ...over,
});

/** A move-out or move-in on the books, as the schedule reads them. */
const booking = (id: string, scheduledAt: string, over: Record<string, unknown> = {}) => ({
  id,
  inspectionType: 'MOVE_OUT',
  propertywareBuildingId: 'building-1',
  propertywareUnitId: null,
  scheduledAt: date(scheduledAt),
  ...over,
});

function build(
  options: {
    leases?: unknown[];
    rows?: unknown[];
    bookings?: unknown[];
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
    inspection: { findMany: jest.fn().mockResolvedValue(options.bookings ?? []) },
    propertywareUnit: { count: jest.fn().mockResolvedValue(options.units ?? 0) },
    $transaction: jest.fn((run: (client: unknown) => unknown) => run(tx)),
  };
  return { service: new LeaseInspectionService(prisma as never), prisma, tx };
}

beforeEach(() => {
  jest.mocked(resolveInspectionPlan).mockReset().mockResolvedValue({} as never);
  jest.mocked(insertInspection).mockReset().mockResolvedValue({ id: 'inspection-new' } as never);
});

/** The office (2026-09-18): a move-out the day after every lease ends, booked sixty days before, for Moses. */
describe('booking the move-outs and move-ins the leases call for', () => {
  it('books a move-out on the day after the lease ends, for whoever handles move-outs', async () => {
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
      expect.objectContaining({ createdById: null, status: InspectionStatus.SCHEDULED, internalNotes: expect.stringContaining('the day after') }),
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

  it('does not book a move-out more than sixty days ahead', async () => {
    const run = await build({ leases: [lease({ endDate: date('2026-12-20') })] }).service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([]);
  });

  it('books a move-in twenty-two days after a leaving tenant goes, for whoever handles move-ins', async () => {
    const { service, tx } = build({
      leases: [lease({ sourceStatus: 'Active - Notice Given', noticeGivenDate: date('2026-09-01'), endDate: date('2026-10-31') })],
    });

    const run = await service.run('org-1', { now: NOW });

    // Out Saturday 31 October: the move-out on Sunday the 1st goes on Monday the 2nd.
    expect(run.changes.map((change) => `${change.kind} ${change.action} ${change.scheduledOn}`)).toEqual([
      'MOVE_OUT BOOK 2026-11-02',
      'MOVE_IN BOOK 2026-11-23',
    ]);
    expect(tx.inspectionAssignment.create.mock.calls.map((call) => call[0].data.technicianId)).toEqual(['moses', 'amy']);
  });

  it('links a move-out the office already booked near the day, rather than booking a second', async () => {
    const { service, prisma } = build({ bookings: [booking('office-booked', '2026-10-22')] });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ action: 'ALREADY_BOOKED', inspectionId: 'office-booked', scheduledOn: '2026-10-22' });
    expect(insertInspection).not.toHaveBeenCalled();
    expect(prisma.leaseScheduledInspection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ outcome: LeaseInspectionOutcome.ALREADY_BOOKED, inspectionId: 'office-booked' }) }),
    );
  });

  it('does not take a booking of its own for another lease at the property as the office’s', async () => {
    const { service } = build({
      leases: [lease(), lease({ id: 'lease-2' })],
      rows: [row({ dueOn: date('2026-10-21'), scheduledOn: date('2026-10-21') }, { scheduledAt: date('2026-10-21') })],
      bookings: [booking('inspection-1', '2026-10-21')],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([expect.objectContaining({ leaseId: 'lease-2', action: 'BOOK' })]);
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

  it('says in a dry run what a booking would refuse, like a property with no floor plan', async () => {
    // 11 of the first run's bookings failed this way while its preview had said none would.
    jest
      .mocked(resolveInspectionPlan)
      .mockRejectedValue(new ApplicationError(409, 'NO_APPROVED_AREAS', 'Upload or define the property floor plan and approve its areas before creating an inspection.'));
    const { service, prisma } = build();

    const run = await service.run('org-1', { now: NOW, dryRun: true });

    expect(run.changes[0]).toMatchObject({ action: 'NOT_BOOKABLE', detail: expect.stringContaining('floor plan') });
    expect(resolveInspectionPlan).toHaveBeenCalledWith(prisma, expect.objectContaining({ inspectionType: 'MOVE_OUT' }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('keeping them in step with the leases', () => {
  it('moves one booked on the old rule, sixty days before the lease ends, to the day after it ends', async () => {
    const { service, tx } = build({
      rows: [row({ dueOn: date('2026-08-21'), scheduledOn: date('2026-09-21') }, { scheduledAt: date('2026-09-21') })],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ action: 'MOVE', scheduledOn: '2026-10-21', inspectionId: 'inspection-1' });
    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
      data: { scheduledAt: date('2026-10-21'), internalNotes: expect.stringContaining('its move-out is the day after') },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'INSPECTION_MOVED_WITH_LEASE' }) });
  });

  it('keeps a note the office rewrote when it moves the inspection', async () => {
    const { service, tx } = build({ rows: [row({}, { internalNotes: 'Gate code with the office.' })] });

    await service.run('org-1', { now: NOW });

    expect(tx.inspection.update).toHaveBeenCalledWith({ where: { id: 'inspection-1' }, data: { scheduledAt: date('2026-10-21') } });
  });

  it('calls off one whose move-out is now more than sixty days away, until it is near', async () => {
    const { service, tx } = build({ leases: [lease({ endDate: date('2026-12-20') })], rows: [row()] });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes[0]).toMatchObject({ action: 'CALL_OFF', detail: expect.stringContaining('booked 60 days before') });
    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
      data: expect.objectContaining({ status: InspectionStatus.CANCELLED, cancellationReason: expect.stringContaining('Mon, Dec 21, 2026') }),
    });
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

  it('books again one it called off, once the lease asks for it again', async () => {
    const { service } = build({
      rows: [
        row(
          { dueOn: date('2026-10-21'), scheduledOn: date('2026-10-21'), outcome: LeaseInspectionOutcome.CALLED_OFF },
          { status: InspectionStatus.CANCELLED, scheduledAt: date('2026-10-21') },
        ),
      ],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([expect.objectContaining({ action: 'BOOK', scheduledOn: '2026-10-21' })]);
  });

  it('clears one it could not book once the lease no longer asks for it yet', async () => {
    const { service, prisma } = build({
      leases: [lease({ endDate: date('2026-12-20') })],
      rows: [row({ outcome: LeaseInspectionOutcome.NOT_BOOKABLE, inspectionId: null }, null)],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([]);
    expect(prisma.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { outcome: LeaseInspectionOutcome.CALLED_OFF, detail: expect.stringContaining('booked 60 days before') },
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

/** The office (2026-09-18): "what we want to automate is the upcoming that has not yet scheduled on the jobber". */
describe('what the office books itself', () => {
  it('comes first: one booked here gives way when the office books the same move-out after it', async () => {
    const { service, tx } = build({
      rows: [row({ dueOn: date('2026-10-21'), scheduledOn: date('2026-10-21') }, { scheduledAt: date('2026-10-21') })],
      bookings: [booking('inspection-1', '2026-10-21'), booking('from-jobber', '2026-10-22')],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([
      expect.objectContaining({ action: 'ALREADY_BOOKED', inspectionId: 'from-jobber', scheduledOn: '2026-10-22' }),
    ]);
    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
      data: expect.objectContaining({ status: InspectionStatus.CANCELLED, cancellationReason: 'The office booked this move-out itself, for Thu, Oct 22, 2026.' }),
    });
    expect(tx.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ outcome: LeaseInspectionOutcome.ALREADY_BOOKED, inspectionId: 'from-jobber' }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'INSPECTION_CALLED_OFF_WITH_LEASE', metadata: expect.objectContaining({ bookedByOffice: 'from-jobber' }) }),
    });
    expect(insertInspection).not.toHaveBeenCalled();
  });

  it('is not given way to when it is weeks from the lease’s day', async () => {
    const { service, prisma } = build({
      rows: [row({ dueOn: date('2026-10-21'), scheduledOn: date('2026-10-21') }, { scheduledAt: date('2026-10-21') })],
      bookings: [booking('old-move-out', '2026-09-01')],
    });

    const run = await service.run('org-1', { now: NOW });

    expect(run.changes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

/** The office (2026-09-18): the overdue ones three a day, not all on one morning. */
describe('move-ins already past their day', () => {
  it('go three a working day from the next one, soonest first', async () => {
    // Out 20-23 August: each move-in was due 11-14 September, inside the two weeks' grace.
    const gone = ['2026-08-22', '2026-08-20', '2026-08-23', '2026-08-21'].map((ends, index) =>
      lease({
        id: `lease-${index + 1}`,
        buildingId: `building-${index + 1}`,
        isActive: false,
        endDate: date(ends),
        deactivatedAt: new Date(`${ends}T12:00:00Z`),
      }),
    );
    const { service } = build({ leases: gone });

    const run = await service.run('org-1', { now: NOW });

    expect(Object.fromEntries(run.changes.map((change) => [change.leaseId, change.scheduledOn]))).toEqual({
      'lease-2': '2026-09-21',
      'lease-4': '2026-09-21',
      'lease-1': '2026-09-21',
      'lease-3': '2026-09-22',
    });
  });
});
