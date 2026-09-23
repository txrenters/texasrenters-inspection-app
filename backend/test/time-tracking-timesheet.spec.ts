import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TimeTrackingService } from '../src/time-tracking/time-tracking.service';

/**
 * The timesheet, the correction and the gap.
 *
 * These three turn a recorded trail into somebody's pay, so what they refuse to
 * do matters as much as what they do. The arithmetic behind them is pinned in
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
  inspectionId: 'insp-1',
  category,
  startedAt: new Date(START),
  endedAt: new Date(START + seconds * 1000),
  durationSeconds: seconds,
  source: 'AUTOMATIC',
  adjustedAt: null,
  flag: null,
  technician: { displayName: technicianId === 'tech-1' ? 'Moses' : 'Kevin' },
  inspection: { inspectionType: 'OCCUPIED', propertywareBuilding: { addressLine1: '1 Oak St' } },
  ...overrides,
});

const gapRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'gap-1',
  technicianId: 'tech-1',
  inspectionId: 'insp-1',
  startedAt: new Date(START),
  endedAt: new Date(START + 4_000_000),
  durationSeconds: 4_000,
  resolvedAt: null,
  resolution: null,
  technician: { displayName: 'Moses' },
  ...overrides,
});

const sheetHarness = (segments: unknown[], gaps: unknown[]) => {
  const prisma = {
    timeSegment: { findMany: jest.fn().mockResolvedValue(segments) },
    trackingGap: { findMany: jest.fn().mockResolvedValue(gaps) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as PrismaService;
  return new TimeTrackingService(prisma);
};

describe('the timesheet', () => {
  it('totals each technician by category', async () => {
    const service = sheetHarness(
      [
        segment('tech-1', 'ONSITE', 3_600),
        segment('tech-1', 'DRIVING', 900),
        segment('tech-1', 'ONSITE', 1_800),
        segment('tech-2', 'ONSITE', 7_200),
      ],
      [],
    );

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    const moses = sheet.totals.find((row) => row.technicianId === 'tech-1')!;
    expect(moses.onsiteSeconds).toBe(5_400);
    expect(moses.drivingSeconds).toBe(900);
    // Sorted by who is owed most, which is the order a payroll run reads in.
    expect(sheet.totals[0]!.technicianId).toBe('tech-2');
  });

  /**
   * The failure this feature exists to prevent, in one assertion.
   *
   * An unsettled gap is neither hours worked nor hours not worked -- it is a
   * question. A timesheet that folds it into a total, or drops it quietly, pays
   * somebody the wrong amount and nobody finds out.
   */
  it('keeps an unsettled gap beside the totals, never inside them', async () => {
    const service = sheetHarness([segment('tech-1', 'ONSITE', 3_600)], [gapRow()]);

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.totals[0]!.onsiteSeconds).toBe(3_600);
    expect(sheet.totals[0]!.unsettledGapSeconds).toBe(4_000);
    expect(sheet.gaps[0]!.resolved).toBe(false);
  });

  it('stops counting a gap once somebody has settled it', async () => {
    const service = sheetHarness(
      [segment('tech-1', 'ONSITE', 3_600)],
      [gapRow({ resolvedAt: new Date(), resolution: 'Phone died; time added back' })],
    );

    const sheet = await service.timesheet(USER, { from: '2026-09-01', to: '2026-09-30' });

    expect(sheet.totals[0]!.unsettledGapSeconds).toBe(0);
  });

  it('refuses a range that runs backwards', async () => {
    const service = sheetHarness([], []);

    await expect(service.timesheet(USER, { from: '2026-09-30', to: '2026-09-01' })).rejects.toThrow(
      /before the first/,
    );
  });
});

describe('correcting a segment', () => {
  const existing = {
    id: 'seg-1',
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
    const prisma = {
      timeSegment: { findFirst: jest.fn().mockResolvedValue(found) },
      auditLog: { create: auditCreate },
      $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as PrismaService;
    return { service: new TimeTrackingService(prisma), createAdjustment, updateSegment, auditCreate };
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
   * And the segment is marked, so the next recompute leaves the decision alone.
   * Without this an administrator's correction would survive until the trail
   * was next re-read, which is worse than not offering the correction at all.
   */
  it('marks the segment so a recompute cannot undo the decision', async () => {
    const { service, updateSegment } = adjustHarness();

    await service.adjustSegment(USER, 'seg-1', correction);

    expect(updateSegment.mock.calls[0]![0].data.adjustedAt).toBeInstanceOf(Date);
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

describe('settling a gap', () => {
  const open = {
    id: 'gap-1',
    technicianId: 'tech-1',
    inspectionId: 'insp-1',
    startedAt: new Date(START),
    endedAt: new Date(START + 4_000_000),
    resolvedAt: null,
  };

  const gapHarness = (found: unknown = open) => {
    const updateGap = jest.fn().mockResolvedValue({});
    const createSegment = jest.fn().mockResolvedValue({});
    const tx = { trackingGap: { update: updateGap }, timeSegment: { create: createSegment } };
    const prisma = {
      trackingGap: { findFirst: jest.fn().mockResolvedValue(found) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as PrismaService;
    return { service: new TimeTrackingService(prisma), updateGap, createSegment };
  };

  /**
   * The office deciding the work happened and the phone missed it.
   *
   * Written as MANUAL so no later recompute can take it away: a technician paid
   * for four hours must not lose them because somebody re-read the trail.
   */
  it('credits time the office decides was worked, and protects it from a recompute', async () => {
    const { service, createSegment } = gapHarness();

    await service.resolveGap(USER, 'gap-1', {
      resolution: 'Phone died at the Feldspar job.',
      creditedMinutes: 240,
    });

    const written = createSegment.mock.calls[0]![0].data;
    expect(written.source).toBe('MANUAL');
    expect(written.durationSeconds).toBe(14_400);
    expect(written.category).toBe('ONSITE');
  });

  /** Settled with nothing credited is a real answer: they were not working. */
  it('can settle a gap without paying for it', async () => {
    const { service, createSegment, updateGap } = gapHarness();

    await service.resolveGap(USER, 'gap-1', { resolution: 'Lunch, off the clock.' });

    expect(createSegment).not.toHaveBeenCalled();
    expect(updateGap.mock.calls[0]![0].data.resolvedAt).toBeInstanceOf(Date);
  });

  it('refuses to settle the same gap twice', async () => {
    const { service } = gapHarness({ ...open, resolvedAt: new Date() });

    await expect(service.resolveGap(USER, 'gap-1', { resolution: 'Again.' })).rejects.toThrow(
      /already been settled/,
    );
  });

  it('refuses to credit time to a gap attached to no job', async () => {
    const { service } = gapHarness({ ...open, inspectionId: null });

    await expect(
      service.resolveGap(USER, 'gap-1', { resolution: 'Worked somewhere.', creditedMinutes: 60 }),
    ).rejects.toThrow(/nothing to credit/);
  });
});
