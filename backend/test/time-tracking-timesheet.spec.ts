import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TimeTrackingService } from '../src/time-tracking/time-tracking.service';

/**
 * The timesheet and the correction.
 *
 * These turn a recorded trail into somebody's pay, so what they refuse to do
 * matters as much as what they do. The arithmetic behind them is pinned in
 * `shared/tests/time-segments.test.ts`; this is about the money.
 */

const USER = {
  id: 'admin-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const START = Date.UTC(2026, 8, 23, 14, 0, 0);

const segment = (
  technicianId: string,
  category: string,
  seconds: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `seg-${category}-${seconds}`,
  technicianId,
  inspectionId: category === 'ONSITE' ? 'insp-1' : null,
  buildingId: category === 'ONSITE' ? 'b1' : null,
  category,
  startedAt: new Date(START),
  endedAt: new Date(START + seconds * 1000),
  durationSeconds: seconds,
  quietSeconds: 0,
  source: 'AUTOMATIC',
  adjustedAt: null,
  flag: null,
  technician: { displayName: technicianId === 'tech-1' ? 'Moses' : 'Kevin' },
  building: category === 'ONSITE' ? { addressLine1: '1 Oak St' } : null,
  inspection: null,
  ...overrides,
});

const sheetHarness = (segments: unknown[]) => {
  const findMany = jest.fn().mockResolvedValue(segments);
  const prisma = { timeSegment: { findMany } } as unknown as PrismaService;
  return { service: new TimeTrackingService(prisma), findMany };
};

describe('the timesheet', () => {
  it('totals each technician: on site, general time, and the two together', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 3_600),
      segment('tech-1', 'GENERAL', 900),
      segment('tech-1', 'ONSITE', 1_800),
      segment('tech-2', 'ONSITE', 7_200),
    ]);

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.totals.find((total) => total.technicianId === 'tech-1')).toMatchObject({
      onsiteSeconds: 5_400,
      generalSeconds: 900,
      totalSeconds: 6_300,
    });
    // Sorted by who worked longest, which is the order a payroll run reads in.
    expect(sheet.totals[0]!.technicianId).toBe('tech-2');
  });

  /**
   * The office reads everything away from a property as one figure. `DRIVING`
   * is only on rows from before the day was read whole, and belongs in it.
   */
  it('counts driving from older rows as general time', async () => {
    const { service } = sheetHarness([segment('tech-1', 'DRIVING', 600), segment('tech-1', 'GENERAL', 300)]);

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.totals[0]!.generalSeconds).toBe(900);
    expect(sheet.segments.map((row) => row.category)).toEqual(['GENERAL', 'GENERAL']);
  });

  /** Counted in the hours, and still visible as what it is. */
  it('says how much of the hours the phone was quiet for', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 3_600, { quietSeconds: 1_200 }),
      segment('tech-1', 'GENERAL', 900, { quietSeconds: 300 }),
    ]);

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.totals[0]).toMatchObject({ totalSeconds: 4_500, quietSeconds: 1_500 });
    expect(sheet.segments[0]!.quietSeconds).toBe(1_200);
  });

  it('names the property of an on-site stretch and none for general time', async () => {
    const { service } = sheetHarness([segment('tech-1', 'ONSITE', 3_600), segment('tech-1', 'GENERAL', 900)]);

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.segments.map((row) => row.address)).toEqual(['1 Oak St', null]);
  });

  /** Rows written before a stretch had a property of its own. */
  it('falls back to the visit’s property for a row that names none', async () => {
    const { service } = sheetHarness([
      segment('tech-1', 'ONSITE', 3_600, {
        building: null,
        inspection: { propertywareBuilding: { addressLine1: '9 Elm Ct' } },
      }),
    ]);

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.segments[0]!.address).toBe('9 Elm Ct');
  });

  /**
   * Read as UTC days, an evening visit in Texas landed on the following day's
   * timesheet. In September Texas is five hours behind.
   */
  it('reads the range as Texas days, inside the caller’s own organization', async () => {
    const { service, findMany } = sheetHarness([]);

    await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30', technicianId: 'tech-1' });

    expect(findMany.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      startedAt: { gte: new Date('2026-09-01T05:00:00.000Z'), lt: new Date('2026-10-01T05:00:00.000Z') },
    });
  });

  it('refuses a range that runs backwards', async () => {
    const { service } = sheetHarness([]);

    await expect(service.timesheet(USER, { from: '2026-09-30', to: '2026-09-01' })).rejects.toThrow(
      /before the first/,
    );
  });

  it('refuses a date it cannot read', async () => {
    const { service } = sheetHarness([]);

    await expect(service.timesheet(USER, { from: 'last week', to: '2026-09-01' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });
});

describe('correcting a segment', () => {
  const existing = {
    id: 'seg-1',
    technicianId: 'tech-1',
    startedAt: new Date(START),
    endedAt: new Date(START + 1_800_000),
    durationSeconds: 1_800,
  };

  const adjustHarness = (found: unknown = existing) => {
    const createAdjustment = jest.fn().mockResolvedValue({});
    const updateSegment = jest.fn().mockResolvedValue({
      id: 'seg-1',
      startedAt: new Date(START),
      endedAt: new Date(START + 3_600_000),
      durationSeconds: 3_600,
    });
    const auditCreate = jest.fn().mockResolvedValue({});
    const tx = {
      timeAdjustment: { create: createAdjustment },
      timeSegment: { update: updateSegment },
    };
    const findFirst = jest.fn().mockResolvedValue(found);
    const prisma = {
      timeSegment: { findFirst },
      auditLog: { create: auditCreate },
      $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as PrismaService;
    const service = new TimeTrackingService(prisma);
    // Reading a day is exercised by its own spec; here it is the thing being
    // asked for, so it is stood in for.
    const read = jest.spyOn(service, 'recomputeDay').mockResolvedValue({
      day: '2026-09-23',
      technicianId: 'tech-1',
      changed: true,
      onsiteSeconds: 0,
      generalSeconds: 0,
      fixesRead: 0,
      fixesDiscarded: 0,
    });
    return { service, createAdjustment, updateSegment, auditCreate, findFirst, read };
  };

  const correction = {
    startedAt: new Date(START).toISOString(),
    endedAt: new Date(START + 3_600_000).toISOString(),
    reason: 'Technician was on site; the phone was in the van.',
  };

  /** The original is kept, not overwritten. That is the whole point. */
  it('writes down what it replaced', async () => {
    const { service, createAdjustment } = adjustHarness();

    await service.adjustSegment(USER, 'seg-1', correction);

    const written = createAdjustment.mock.calls[0]![0].data;
    expect(written.beforeDurationSeconds).toBe(1_800);
    expect(written.afterDurationSeconds).toBe(3_600);
    expect(written.reason).toBe(correction.reason);
  });

  /**
   * And the segment is marked, so the next reading leaves the decision alone.
   * Without this an administrator's correction would survive until the trail
   * was next re-read, which is worse than not offering the correction at all.
   */
  it('marks the segment so a later reading cannot undo the decision', async () => {
    const { service, updateSegment } = adjustHarness();

    await service.adjustSegment(USER, 'seg-1', correction);

    expect(updateSegment.mock.calls[0]![0].data.adjustedAt).toBeInstanceOf(Date);
  });

  /**
   * A stretch made longer covers minutes the trail had called something else.
   * Those rows have to give way, now, or the minutes are on the sheet twice.
   */
  it('reads the technician’s day again, as the person who made the correction', async () => {
    const { service, read } = adjustHarness();

    await service.adjustSegment(USER, 'seg-1', correction);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('org-1', 'tech-1', '2026-09-23', USER);
  });

  it('still saves the correction when the day could not be read again', async () => {
    const { service, read } = adjustHarness();
    read.mockRejectedValue(new Error('database unreachable'));

    await expect(service.adjustSegment(USER, 'seg-1', correction)).resolves.toMatchObject({
      adjusted: true,
      durationSeconds: 3_600,
    });
  });

  it('only finds a segment inside the caller’s own organization', async () => {
    const { service, findFirst } = adjustHarness(null);

    await expect(service.adjustSegment(USER, 'seg-1', correction)).rejects.toThrow(/no longer on the timesheet/);
    expect(findFirst.mock.calls[0]![0].where).toEqual({ id: 'seg-1', organizationId: 'org-1' });
  });

  it('refuses a segment that would end before it starts', async () => {
    const { service } = adjustHarness();

    await expect(
      service.adjustSegment(USER, 'seg-1', {
        startedAt: correction.endedAt,
        endedAt: correction.startedAt,
        reason: 'Typed the wrong way round.',
      }),
    ).rejects.toThrow(/end after it starts/);
  });

  /** The reason is not audited: it is the technician's business as much as the office's. */
  it('audits the change in seconds and not the reason', async () => {
    const { service, auditCreate } = adjustHarness();

    await service.adjustSegment(USER, 'seg-1', { ...correction, reason: 'A private note.' });

    expect(auditCreate.mock.calls[0]![0].data.metadata).toEqual({
      beforeSeconds: 1_800,
      afterSeconds: 3_600,
    });
  });
});
