import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TimeTrackingService } from '../src/time-tracking/time-tracking.service';

/**
 * The timesheet and the correction.
 *
 * These turn a recorded trail into somebody's pay, so what they refuse to do
 * matters as much as what they do. The arithmetic behind them is pinned in
 * `shared/tests/time-segments.test.ts`; this is about the money, and about the
 * shape the office reads it in: one day, one row per property.
 */

const USER = {
  id: 'admin-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const DAY = '2026-10-06';
/** Ten in the morning in Texas, on that day. */
const START = Date.UTC(2026, 9, 6, 15, 0, 0);
const at = (minutes: number) => new Date(START + minutes * 60_000);

let next = 0;
const segment = (
  technicianId: string,
  category: string,
  fromMinutes: number,
  toMinutes: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `seg-${(next += 1)}`,
  technicianId,
  inspectionId: category === 'ONSITE' ? 'insp-1' : null,
  buildingId: category === 'ONSITE' ? 'b1' : null,
  category,
  startedAt: at(fromMinutes),
  endedAt: at(toMinutes),
  durationSeconds: (toMinutes - fromMinutes) * 60,
  quietSeconds: 0,
  source: 'AUTOMATIC',
  adjustedAt: null,
  technician: { displayName: technicianId === 'tech-1' ? 'Moses' : 'Kevin' },
  building: category === 'ONSITE' ? { addressLine1: '1 Oak St' } : null,
  inspection: null,
  ...overrides,
});

/** Another property, for the same technician. */
const ELSEWHERE = { buildingId: 'b2', inspectionId: 'insp-2', building: { addressLine1: '9 Elm Ct' } };

const sheetHarness = (segments: unknown[]) => {
  const findMany = jest.fn().mockResolvedValue(segments);
  const prisma = { timeSegment: { findMany } } as unknown as PrismaService;
  return { service: new TimeTrackingService(prisma), findMany };
};

describe('the timesheet', () => {
  it('totals each technician: on site, general time, and the two together', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 0, 60),
      segment('tech-1', 'GENERAL', 60, 75),
      segment('tech-1', 'ONSITE', 75, 105, ELSEWHERE),
      segment('tech-2', 'ONSITE', 0, 120),
    ]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.totals.find((total) => total.technicianId === 'tech-1')).toMatchObject({
      onsiteSeconds: 5_400,
      generalSeconds: 900,
      totalSeconds: 6_300,
    });
    // Sorted by who worked longest, which is the order a payroll run reads in.
    expect(sheet.totals[0]!.technicianId).toBe('tech-2');
  });

  /**
   * The office, 2026-10-06: one address showed as four rows on one day. It is
   * one visit -- the minutes outside the circle are general time, and the row
   * says how long of the visit was spent inside.
   */
  it('shows a property once a day however often the technician went in and out', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 0, 20),
      segment('tech-1', 'GENERAL', 20, 23),
      segment('tech-1', 'ONSITE', 23, 40, { quietSeconds: 300 }),
      segment('tech-1', 'GENERAL', 40, 41),
      segment('tech-1', 'ONSITE', 41, 50),
    ]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.visits).toHaveLength(1);
    expect(sheet.visits[0]).toMatchObject({
      address: '1 Oak St',
      arrivedAt: at(0).toISOString(),
      leftAt: at(50).toISOString(),
      onsiteSeconds: (20 + 17 + 9) * 60,
      quietSeconds: 300,
      stays: 3,
    });
    expect(sheet.totals[0]!.generalSeconds).toBe(4 * 60);
  });

  it('keeps two properties, and two technicians at one property, apart', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 0, 30),
      segment('tech-1', 'ONSITE', 45, 90, ELSEWHERE),
      segment('tech-2', 'ONSITE', 0, 30),
    ]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.visits.map((visit) => `${visit.technician} ${visit.address}`)).toEqual([
      'Kevin 1 Oak St',
      'Moses 1 Oak St',
      'Moses 9 Elm Ct',
    ]);
  });

  /** A correction is merged against exactly these, so they must all be there. */
  it('lists every stretch behind a row', async () => {
    const first = segment('tech-1', 'ONSITE', 0, 20);
    const second = segment('tech-1', 'ONSITE', 25, 40);
    const { service } = sheetHarness([first, segment('tech-1', 'GENERAL', 20, 25), second]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.visits[0]!.segmentIds).toEqual([first.id, second.id]);
  });

  /** Somebody paid from this is entitled to know which hours a person decided. */
  it('marks a visit with a corrected or hand-added stretch in it', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 0, 20),
      segment('tech-1', 'ONSITE', 25, 40, { adjustedAt: at(100) }),
      segment('tech-1', 'ONSITE', 0, 30, { ...ELSEWHERE, source: 'MANUAL' }),
    ]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.visits.map((visit) => [visit.address, visit.adjusted, visit.addedByHand])).toEqual([
      ['1 Oak St', true, false],
      ['9 Elm Ct', false, true],
    ]);
  });

  /** A corrected stretch can run past a later one; the departure is the latest end. */
  it('takes the last departure, not the end of the last stretch to start', async () => {
    const { service } = sheetHarness([segment('tech-1', 'ONSITE', 0, 90), segment('tech-1', 'ONSITE', 30, 40)]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.visits[0]!.leftAt).toBe(at(90).toISOString());
  });

  /**
   * The office reads everything away from a property as one figure. `DRIVING`
   * is only on rows from before the day was read whole, and belongs in it.
   */
  it('counts driving from older rows as general time, and lists it as no visit', async () => {
    const { service } = sheetHarness([segment('tech-1', 'DRIVING', 0, 10), segment('tech-1', 'GENERAL', 10, 15)]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.totals[0]!.generalSeconds).toBe(900);
    expect(sheet.visits).toEqual([]);
  });

  /** Rows written before a stretch had a property of its own. */
  it('falls back to the visit’s property for a row that names none', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 0, 60, {
        buildingId: null,
        building: null,
        inspection: { propertywareBuilding: { addressLine1: '9 Elm Ct' } },
      }),
    ]);

    const sheet = await service.timesheet(USER, { date: DAY });

    expect(sheet.visits[0]!.address).toBe('9 Elm Ct');
  });

  /**
   * One Texas day, midnight to midnight there, whoever is asking. In October
   * Texas is five hours behind UTC.
   */
  it('reads one Texas day, inside the caller’s own organization', async () => {
    const { service, findMany } = sheetHarness([]);

    await service.timesheet(USER, { date: DAY, technicianId: 'tech-1' });

    expect(findMany.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      startedAt: { gte: new Date('2026-10-06T05:00:00.000Z'), lt: new Date('2026-10-07T05:00:00.000Z') },
    });
  });

  it('refuses a day it cannot read', async () => {
    const { service } = sheetHarness([]);

    await expect(service.timesheet(USER, { date: 'last week' })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('correcting the time at a property', () => {
  const first = segment('tech-1', 'ONSITE', 0, 20);
  const second = segment('tech-1', 'ONSITE', 25, 40);

  const correctHarness = (found: unknown[] = [first, second]) => {
    const tx = {
      timeAdjustment: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      timeSegment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({
          id: first.id,
          startedAt: at(0),
          endedAt: at(60),
          durationSeconds: 3_600,
        }),
      },
    };
    const rows = found as { technicianId: string; startedAt: Date }[];
    const audit = jest.fn().mockResolvedValue({});
    const prisma = {
      timeSegment: {
        findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
        findMany: jest.fn().mockResolvedValue(found),
      },
      auditLog: { create: audit },
      $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as PrismaService;
    const service = new TimeTrackingService(prisma);
    // Reading a day is exercised by its own spec; here it is the thing being
    // asked for, so it is stood in for.
    const read = jest
      .spyOn(service as unknown as { readDay: (...args: unknown[]) => Promise<unknown> }, 'readDay')
      .mockResolvedValue({});
    const again = jest.spyOn(service, 'recomputeDay').mockResolvedValue({
      day: DAY,
      technicianId: 'tech-1',
      changed: true,
      onsiteSeconds: 0,
      generalSeconds: 0,
      fixesRead: 0,
      fixesDiscarded: 0,
    });
    return { service, tx, audit, prisma, read, again };
  };

  const correction = {
    segmentIds: [first.id, second.id],
    startedAt: at(0).toISOString(),
    endedAt: at(60).toISOString(),
    reason: 'Technician was on site; the phone was in the van.',
  };

  /** One row on the timesheet, one stretch after it is corrected. */
  it('makes every stretch behind the row one stretch, from here to here', async () => {
    const { service, tx } = correctHarness();

    await service.correctVisit(USER, correction);

    expect(tx.timeSegment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: first.id },
        data: expect.objectContaining({ startedAt: at(0), endedAt: at(60), durationSeconds: 3_600 }),
      }),
    );
    expect(tx.timeSegment.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: { in: [second.id] } },
    });
  });

  /** The original is kept, not overwritten. That is the whole point. */
  it('writes down what the whole visit said before, and why it changed', async () => {
    const { service, tx } = correctHarness();

    await service.correctVisit(USER, correction);

    expect(tx.timeAdjustment.create.mock.calls[0]![0].data).toMatchObject({
      segmentId: first.id,
      adminId: 'admin-1',
      beforeStartedAt: at(0),
      beforeEndedAt: at(40),
      beforeDurationSeconds: (20 + 15) * 60,
      afterDurationSeconds: 3_600,
      reason: correction.reason,
    });
  });

  /** A stretch that was corrected before keeps its history when it is merged away. */
  it('moves earlier corrections of the merged stretches onto the one that stays', async () => {
    const { service, tx } = correctHarness();

    await service.correctVisit(USER, correction);

    expect(tx.timeAdjustment.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', segmentId: { in: [second.id] } },
      data: { segmentId: first.id },
    });
  });

  /**
   * And the stretch is marked, so the next reading leaves the decision alone.
   * Without this the correction would last until the trail was next re-read.
   */
  it('marks the stretch so a later reading cannot undo the decision', async () => {
    const { service, tx } = correctHarness();

    await service.correctVisit(USER, correction);

    expect(tx.timeSegment.update.mock.calls[0]![0].data.adjustedAt).toBeInstanceOf(Date);
  });

  /**
   * A visit made longer covers minutes the trail had called general time.
   * Those rows have to give way, now, or the minutes are on the sheet twice.
   */
  it('reads the technician’s day again, as the person who made the correction', async () => {
    const { service, read, again } = correctHarness();

    await service.correctVisit(USER, correction);

    expect(read).toHaveBeenCalledWith('org-1', 'tech-1', DAY, USER);
    expect(again).not.toHaveBeenCalled();
  });

  it('reads the other day too when the correction moves the visit onto it', async () => {
    const { service, again } = correctHarness();

    await service.correctVisit(USER, {
      ...correction,
      startedAt: '2026-10-07T14:00:00.000Z',
      endedAt: '2026-10-07T15:00:00.000Z',
    });

    expect(again).toHaveBeenCalledWith('org-1', 'tech-1', '2026-10-07', USER);
  });

  it('still saves the correction when the day could not be read again', async () => {
    const { service, read } = correctHarness();
    read.mockRejectedValue(new Error('database unreachable'));

    await expect(service.correctVisit(USER, correction)).resolves.toMatchObject({
      adjusted: true,
      durationSeconds: 3_600,
    });
  });

  it('only finds stretches inside the caller’s own organization', async () => {
    const { service, prisma } = correctHarness();

    await service.correctVisit(USER, correction);

    const lookups = prisma.timeSegment as unknown as { findFirst: jest.Mock; findMany: jest.Mock };
    expect(lookups.findFirst.mock.calls[0]![0].where.organizationId).toBe('org-1');
    expect(lookups.findMany.mock.calls[0]![0].where.organizationId).toBe('org-1');
  });

  /** The sweep may have rewritten the visit since the page loaded it. */
  it('refuses when a stretch behind the row has gone, rather than correcting half a visit', async () => {
    const { service, tx } = correctHarness([first]);

    await expect(service.correctVisit(USER, correction)).rejects.toThrow(/Refresh the page/);
    expect(tx.timeSegment.update).not.toHaveBeenCalled();
  });

  it('refuses stretches that are not one technician’s time at one property', async () => {
    const elsewhere = segment('tech-1', 'ONSITE', 25, 40, ELSEWHERE);
    const between = segment('tech-1', 'GENERAL', 20, 25);
    const someoneElse = segment('tech-2', 'ONSITE', 25, 40);

    for (const odd of [elsewhere, between, someoneElse]) {
      const { service } = correctHarness([first, odd]);
      await expect(service.correctVisit(USER, { ...correction, segmentIds: [first.id, odd.id] })).rejects.toThrow(
        /not one technician’s time at one property/,
      );
    }
  });

  it('refuses a visit that would end before it starts', async () => {
    const { service } = correctHarness();

    await expect(
      service.correctVisit(USER, { ...correction, startedAt: correction.endedAt, endedAt: correction.startedAt }),
    ).rejects.toThrow(/end after it starts/);
  });

  /** The reason is not audited: it is the technician's business as much as the office's. */
  it('audits the change in seconds and not the reason', async () => {
    const { service, audit } = correctHarness();

    await service.correctVisit(USER, { ...correction, reason: 'A private note.' });

    expect(audit.mock.calls[0]![0].data).toMatchObject({
      action: 'TIME_VISIT_CORRECTED',
      actorUserId: 'admin-1',
      metadata: { beforeSeconds: 2_100, afterSeconds: 3_600, stretchesMerged: 2 },
    });
  });
});
