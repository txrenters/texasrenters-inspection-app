import { InspectionStatus, InspectionType } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { LateMoveOutService } from '../src/planning/late-move-outs.service';

/**
 * A move-out booked onto a technician's benefit-package day after the quarter
 * was published (the office, 2026-10-01).
 *
 * Production: 40 of 54 move-outs were entered under fifteen days before their
 * day, and the Q4 plan was built around 1 of its 16. So the day a build
 * trimmed for a move-out is the exception; this is the rule -- found on the
 * day as it stands, offered to the office, and moved only when confirmed.
 */

const PLAN = { quarterYear: 2026, quarterNumber: 4, holidays: [] as string[], startsOn: null, minStopsPerDay: 9 };
const MOSES = { id: 'moses', displayName: 'Moses Rodriguez' };

/** A published benefit-package visit on 7 October with Moses, `metres` north of the move-out. */
const visit = (id: string, metresNorth: number, extra: Record<string, unknown> = {}) => ({
  inspection: {
    id,
    status: InspectionStatus.SCHEDULED,
    finalizedAt: null,
    scheduledAt: new Date('2026-10-07T00:00:00.000Z'),
    propertywareBuilding: { addressLine1: `${id} Street`, latitude: 29.76 + metresNorth / 111_320, longitude: -95.37, geofence: null },
    assignments: [{ technician: MOSES }],
    ...extra,
  },
});

/** A full day of nine: six near the move-out and three well away from it. */
const DAY = [
  ...[100, 200, 300, 400, 500].map((metres, index) => visit(`near-${index + 1}`, metres)),
  visit('mid', 1_000),
  visit('far-1', 5_000),
  visit('far-2', 6_000),
  visit('far-3', 7_000),
];

const moveOut = (extra: Record<string, unknown> = {}) => ({
  id: 'move-out-1',
  inspectionType: InspectionType.MOVE_OUT,
  scheduledAt: new Date('2026-10-07T00:00:00.000Z'),
  propertywareBuilding: { addressLine1: '9 Move Out Ln', latitude: 29.76, longitude: -95.37, geofence: null },
  assignments: [{ technicianId: 'moses' }],
  ...extra,
});

function build(options: { stops?: unknown[]; bookings?: unknown[]; anchors?: unknown[]; movable?: unknown[] } = {}) {
  const updateInspection = jest.fn().mockResolvedValue({});
  const auditCreate = jest.fn().mockResolvedValue({});
  const anchorUpsert = jest.fn().mockResolvedValue({});
  const inspectionFindMany = jest.fn(({ where }: { where: { id?: unknown } }) =>
    Promise.resolve(where.id ? (options.movable ?? []) : (options.bookings ?? [moveOut()])),
  );
  const prisma = {
    tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue(PLAN) },
    tbpQuarterPlanStop: { findMany: jest.fn().mockResolvedValue(options.stops ?? DAY) },
    tbpQuarterPlanAnchor: { findMany: jest.fn().mockResolvedValue(options.anchors ?? []), upsert: anchorUpsert },
    inspection: { findMany: inspectionFindMany, count: jest.fn().mockResolvedValue(2) },
    auditLog: { create: auditCreate },
  } as unknown as PrismaService;
  const service = new LateMoveOutService(prisma, { updateInspection } as never);
  return { service, updateInspection, auditCreate, anchorUpsert, inspectionFindMany };
}

const USER = { id: 'office-1', organizationId: 'org-1', permissions: [] } as unknown as AuthenticatedUser;

describe('a move-out booked onto a published day', () => {
  it('is found on the day of whoever has it now', async () => {
    const { conflicts } = await build().service.conflicts('org-1', 'plan-1');

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      date: '2026-10-07',
      technician: MOSES,
      bookings: [{ inspectionId: 'move-out-1', kind: 'MOVE_OUT', address: '9 Move Out Ln' }],
      visits: 9,
    });
  });

  it('offers the three visits furthest from it', async () => {
    const { conflicts } = await build().service.conflicts('org-1', 'plan-1');

    expect(conflicts[0]!.suggested.map((entry) => entry.inspectionId)).toEqual(['far-3', 'far-2', 'far-1']);
  });

  it('offers three for each booking on the day', async () => {
    const second = moveOut({ id: 'move-in-1', inspectionType: InspectionType.MOVE_IN });
    const { conflicts } = await build({ bookings: [moveOut(), second] }).service.conflicts('org-1', 'plan-1');

    expect(conflicts[0]!.suggested).toHaveLength(6);
  });

  it('names the Monday after, passing over a holiday Monday, and how full it is', async () => {
    // Monday 12 October 2026 is Columbus Day.
    const { conflicts } = await build().service.conflicts('org-1', 'plan-1');

    expect(conflicts[0]).toMatchObject({ monday: '2026-10-19', mondayLoad: 2 });
  });

  it('has no Monday in the quarter’s last week', async () => {
    const late = (stop: ReturnType<typeof visit>) => ({
      inspection: { ...stop.inspection, scheduledAt: new Date('2026-12-29T00:00:00.000Z') },
    });
    const { conflicts } = await build({
      stops: DAY.map(late),
      bookings: [moveOut({ scheduledAt: new Date('2026-12-29T00:00:00.000Z') })],
    }).service.conflicts('org-1', 'plan-1');

    expect(conflicts[0]).toMatchObject({ monday: null, mondayLoad: 0 });
  });
});

describe('a booking that is not a late move-out', () => {
  it('is not one the plan was already built around', async () => {
    const anchors = [{ inspectionId: 'move-out-1', technicianId: 'moses', date: new Date('2026-10-07T00:00:00.000Z') }];

    expect((await build({ anchors }).service.conflicts('org-1', 'plan-1')).conflicts).toEqual([]);
  });

  it('is not on somebody else’s day', async () => {
    const bookings = [moveOut({ assignments: [{ technicianId: 'beatriz' }] })];

    expect((await build({ bookings }).service.conflicts('org-1', 'plan-1')).conflicts).toEqual([]);
  });

  it('is not on a day with no benefit-package visit left to move', async () => {
    const started = DAY.map((stop) => visit(stop.inspection.id, 0, { status: InspectionStatus.IN_PROGRESS }));

    expect((await build({ stops: started }).service.conflicts('org-1', 'plan-1')).conflicts).toEqual([]);
  });

  it('is not on a day already down to what it holds beside the move-out', async () => {
    // Nine less three: six visits and a move-out is a day already adjusted, by
    // this or by hand -- and stays off the list after a rebuild clears the record.
    const adjusted = DAY.slice(0, 6);

    expect((await build({ stops: adjusted }).service.conflicts('org-1', 'plan-1')).conflicts).toEqual([]);
  });

  it('offers only what takes a day over what it holds beside the move-out', async () => {
    // Seven: the one furthest from the move-out goes, and the six that fit beside it stay.
    const { conflicts } = await build({ stops: DAY.slice(0, 7) }).service.conflicts('org-1', 'plan-1');

    expect(conflicts[0]!.suggested.map((entry) => entry.inspectionId)).toEqual(['far-1']);
  });

  it('is not one assigned to nobody', async () => {
    const bookings = [moveOut({ assignments: [] })];

    expect((await build({ bookings }).service.conflicts('org-1', 'plan-1')).conflicts).toEqual([]);
  });
});

describe('moving the visits the office confirmed', () => {
  const ORIGINAL = process.env.JOBBER_PUSH_EDITS_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.JOBBER_PUSH_EDITS_ENABLED;
    else process.env.JOBBER_PUSH_EDITS_ENABLED = ORIGINAL;
  });
  const input = { date: '2026-10-07', technicianId: 'moses', inspectionIds: ['far-1', 'far-2', 'far-3'] };
  const movable = input.inspectionIds.map((id) => ({ id, jobberVisitId: `visit-${id}` }));

  it('reschedules each to the Monday, as the console reschedules a visit', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    const { service, updateInspection } = build({ movable });

    const result = await service.moveToMonday(USER, 'plan-1', input);

    expect(result).toEqual({ monday: '2026-10-19', moved: 3, failed: [] });
    expect(updateInspection.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['far-1', { scheduledAt: '2026-10-19' }],
      ['far-2', { scheduledAt: '2026-10-19' }],
      ['far-3', { scheduledAt: '2026-10-19' }],
    ]);
  });

  it('records what went where', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    const { service, auditCreate } = build({ movable });

    await service.moveToMonday(USER, 'plan-1', input);

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'TBP_VISITS_MOVED_TO_MONDAY',
        entityType: 'TbpQuarterPlan',
        entityId: 'plan-1',
        actorUserId: 'office-1',
        metadata: expect.objectContaining({ from: '2026-10-07', to: '2026-10-19', moved: input.inspectionIds }),
      }),
    });
  });

  it('records the day as built around its move-out, so it is not offered again', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    const { service, anchorUpsert } = build({ movable });

    await service.moveToMonday(USER, 'plan-1', input);

    expect(anchorUpsert).toHaveBeenCalledWith({
      where: { planId_inspectionId: { planId: 'plan-1', inspectionId: 'move-out-1' } },
      create: expect.objectContaining({ technicianId: 'moses', date: new Date('2026-10-07T00:00:00.000Z') }),
      update: { technicianId: 'moses', date: new Date('2026-10-07T00:00:00.000Z') },
    });
  });

  it('moves nothing when Jobber visits are among them and edits are not sent to Jobber', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'false';
    const { service, updateInspection } = build({ movable });

    await expect(service.moveToMonday(USER, 'plan-1', input)).rejects.toMatchObject({ code: 'SCHEDULED_IN_JOBBER' });
    expect(updateInspection).not.toHaveBeenCalled();
  });

  it('refuses a visit that is not one of that day’s, and moves nothing', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    // The database finds only two of the three on that day with that person.
    const { service, updateInspection } = build({ movable: movable.slice(0, 2) });

    await expect(service.moveToMonday(USER, 'plan-1', input)).rejects.toMatchObject({ code: 'NOT_ON_THAT_DAY' });
    expect(updateInspection).not.toHaveBeenCalled();
  });

  it('refuses a day with no late move-out on it', async () => {
    const { service } = build({ bookings: [] });

    await expect(service.moveToMonday(USER, 'plan-1', input)).rejects.toMatchObject({ code: 'NO_LATE_MOVE_OUT' });
  });

  it('refuses when the quarter has no Monday left', async () => {
    const late = DAY.map((stop) => ({ inspection: { ...stop.inspection, scheduledAt: new Date('2026-12-29T00:00:00.000Z') } }));
    const { service } = build({ stops: late, bookings: [moveOut({ scheduledAt: new Date('2026-12-29T00:00:00.000Z') })] });

    await expect(
      service.moveToMonday(USER, 'plan-1', { ...input, date: '2026-12-29' }),
    ).rejects.toMatchObject({ code: 'NO_MONDAY_LEFT' });
  });

  it('says which visits could not be moved, and moves the rest', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    const { service, updateInspection } = build({ movable });
    updateInspection.mockRejectedValueOnce(new Error('An inspection of this type is already scheduled for this unit at that time.'));

    const result = await service.moveToMonday(USER, 'plan-1', input);

    expect(result.moved).toBe(2);
    expect(result.failed).toEqual([
      { inspectionId: 'far-1', message: 'An inspection of this type is already scheduled for this unit at that time.' },
    ]);
  });
});
