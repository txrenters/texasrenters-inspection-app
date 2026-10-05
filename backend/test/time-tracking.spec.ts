import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TimeTrackingService } from '../src/time-tracking/time-tracking.service';

/**
 * Reading a technician's day from the trail.
 *
 * The arithmetic is pinned in `shared/tests/time-segments.test.ts`. What is
 * pinned here is everything around it: which properties count, that the Start
 * and End buttons do not, what a reading is allowed to overwrite, and that
 * reading the same day twice changes nothing the second time.
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
const METRE = 1 / 111_320;
const PROPERTY = { latitude: 29.76, longitude: -95.37 };

const instant = (seconds: number) => new Date(START + seconds * 1000);

const ping = (seconds: number, metresNorth: number, accuracy = 5) => ({
  latitude: PROPERTY.latitude + metresNorth * METRE,
  longitude: PROPERTY.longitude,
  accuracyMeters: accuracy,
  recordedAt: instant(seconds),
});

/** A stretch at one place, one fix every thirty seconds as the recorder makes them. */
const at = (fromSeconds: number, forSeconds: number, metresNorth: number) =>
  Array.from({ length: Math.floor(forSeconds / 30) + 1 }, (_, index) =>
    ping(fromSeconds + index * 30, metresNorth),
  );

const building = (id: string, metresNorth = 0, geofence: unknown = null) => ({
  id,
  latitude: PROPERTY.latitude + metresNorth * METRE,
  longitude: PROPERTY.longitude,
  geofence,
});

const visit = (id: string, at_: unknown) => ({ id, propertywareBuilding: at_ });

/** One property, then a drive, then a second one four kilometres on. */
const TWO_VISITS = [visit('insp-1', building('b1')), visit('insp-2', building('b2', 4_000))];
const TWO_PROPERTY_TRAIL = [...at(0, 900, 5), ...at(930, 600, 2_000), ...at(1_560, 900, 4_003)];

const row = (
  id: string,
  category: string,
  buildingId: string | null,
  inspectionId: string | null,
  fromSeconds: number,
  toSeconds: number,
) => ({
  id,
  category,
  buildingId,
  inspectionId,
  startedAt: instant(fromSeconds),
  endedAt: instant(toSeconds),
  durationSeconds: toSeconds - fromSeconds,
  quietSeconds: 0,
});

/** What reading `TWO_PROPERTY_TRAIL` against `TWO_VISITS` writes. */
const TWO_PROPERTY_ROWS = [
  row('seg-1', 'ONSITE', 'b1', 'insp-1', 0, 930),
  row('seg-2', 'GENERAL', null, null, 930, 1_560),
  row('seg-3', 'ONSITE', 'b2', 'insp-2', 1_560, 2_460),
];

const harness = (
  given: {
    visits?: unknown[];
    pings?: unknown[] | (() => Promise<unknown[]>);
    stored?: unknown[];
    decided?: unknown[];
    openGaps?: number;
  } = {},
) => {
  const tx = {
    timeSegment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    trackingGap: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const visits = jest.fn().mockResolvedValue(given.visits ?? [visit('insp-1', building('b1'))]);
  const pings =
    typeof given.pings === 'function' ? jest.fn(given.pings) : jest.fn().mockResolvedValue(given.pings ?? []);
  // Asked twice in one reading: once for the hours a person has decided, once
  // for the rows already stored. Told apart by the question, not the order.
  const segments = jest.fn(({ where }: { where: { AND?: unknown[] } }) =>
    Promise.resolve(where.AND ? (given.decided ?? []) : (given.stored ?? [])),
  );
  const audit = jest.fn().mockResolvedValue({});
  const transaction = jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx));
  const prisma = {
    inspection: { findMany: visits },
    technicianLocationPing: { findMany: pings, groupBy: jest.fn().mockResolvedValue([]) },
    timeSegment: { findMany: segments, groupBy: jest.fn().mockResolvedValue([]) },
    trackingGap: { count: jest.fn().mockResolvedValue(given.openGaps ?? 0) },
    auditLog: { create: audit },
    $transaction: transaction,
  } as unknown as PrismaService;
  return { service: new TimeTrackingService(prisma), prisma, tx, visits, pings, segments, audit, transaction };
};

const created = (tx: { timeSegment: { createMany: jest.Mock } }) =>
  (tx.timeSegment.createMany.mock.calls[0]?.[0]?.data ?? []) as {
    category: string;
    buildingId: string | null;
    inspectionId: string | null;
    organizationId: string;
    technicianId: string;
    startedAt: Date;
    endedAt: Date;
    durationSeconds: number;
    quietSeconds: number;
  }[];

describe('reading a day from the trail', () => {
  it('records the time at each property and the time between them', async () => {
    const { service, tx } = harness({ visits: TWO_VISITS, pings: TWO_PROPERTY_TRAIL });

    const result = await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(created(tx).map((written) => [written.category, written.buildingId])).toEqual([
      ['ONSITE', 'b1'],
      ['GENERAL', null],
      ['ONSITE', 'b2'],
    ]);
    expect(result).toMatchObject({ changed: true, onsiteSeconds: 930 + 900, generalSeconds: 630 });
  });

  /** General time is between properties, so it is no visit's and no property's. */
  it('files on-site time under the visit and general time under nothing', async () => {
    const { service, tx } = harness({ visits: TWO_VISITS, pings: TWO_PROPERTY_TRAIL });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(created(tx).map((written) => written.inspectionId)).toEqual(['insp-1', null, 'insp-2']);
  });

  /**
   * The office, 2026-10-06: a technician looks round a property before
   * pressing Start and does not always press End when they leave. The visits
   * here carry neither timestamp and the hours are all there.
   */
  it('does not need Start job or End job to have been pressed', async () => {
    const { service, visits } = harness({ visits: TWO_VISITS, pings: TWO_PROPERTY_TRAIL });

    const result = await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(result.onsiteSeconds).toBe(930 + 900);
    // And is never handed them: what is not selected cannot become the hours.
    expect(Object.keys(visits.mock.calls[0]![0].select)).toEqual(['id', 'propertywareBuilding']);
  });

  /**
   * Two jobs at one building on one day are one stay. Read per job, each was
   * given the whole of it and the technician was on site twice at once.
   */
  it('counts a property once however many visits are booked there', async () => {
    const { service, tx } = harness({
      visits: [visit('insp-1', building('b1')), visit('insp-9', building('b1'))],
      pings: at(0, 1_800, 5),
    });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(created(tx)).toHaveLength(1);
    expect(created(tx)[0]).toMatchObject({ buildingId: 'b1', inspectionId: 'insp-1', durationSeconds: 1_800 });
  });

  it('carries a visit through a phone that went quiet indoors, and says how long for', async () => {
    const { service, tx } = harness({ pings: [...at(0, 600, 5), ...at(3_000, 600, 5)] });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(created(tx)).toHaveLength(1);
    expect(created(tx)[0]).toMatchObject({ durationSeconds: 3_600, quietSeconds: 2_400 });
  });

  it('uses the distances the office set for a property in place of the defaults', async () => {
    // Sixty metres from the pin: outside the default circle, inside this one.
    const wide = building('b1', 0, { latitude: null, longitude: null, enterRadiusMeters: 100, exitRadiusMeters: 150 });
    const { service, tx } = harness({ visits: [visit('insp-1', wide)], pings: at(0, 1_800, 60) });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(created(tx)[0]).toMatchObject({ category: 'ONSITE', durationSeconds: 1_800 });
  });

  it('writes nothing for a property that has no coordinates to draw a circle round', async () => {
    const nowhere = { id: 'b1', latitude: null, longitude: null, geofence: null };
    const { service, transaction } = harness({ visits: [visit('insp-1', nowhere)], pings: at(0, 1_800, 5) });

    const result = await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(result).toMatchObject({ changed: false, onsiteSeconds: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('which visits are on the day', () => {
  it('asks only for this technician’s visits, in this organization, on the Texas day', async () => {
    const { service, visits } = harness();

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    const where = visits.mock.calls[0]![0].where;
    expect(where.organizationId).toBe('org-1');
    expect(where.assignments).toEqual({ some: { isCurrent: true, technicianId: 'tech-1' } });
    // Midnight to midnight in Texas, which in October is five hours behind UTC.
    expect(where.OR[0].scheduledAt).toEqual({
      gte: new Date('2026-10-06T05:00:00.000Z'),
      lt: new Date('2026-10-07T05:00:00.000Z'),
    });
  });

  it('reads the trail for the same Texas day, and only this technician’s', async () => {
    const { service, pings } = harness();

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(pings.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      recordedAt: { gte: new Date('2026-10-06T05:00:00.000Z'), lt: new Date('2026-10-07T05:00:00.000Z') },
    });
  });

  it('refuses a day it cannot read as a date', () => {
    const { service } = harness();

    expect(() => service.recomputeDay('org-1', 'tech-1', 'yesterday', null)).toThrow(/YYYY-MM-DD/);
  });
});

/**
 * Today is read every few minutes. Nearly all of it is the same each time, and
 * what is the same must be left exactly as it is.
 */
describe('reading a day that has been read before', () => {
  it('writes nothing, and audits nothing, when the day already says what the trail says', async () => {
    const { service, transaction, audit } = harness({
      visits: TWO_VISITS,
      pings: TWO_PROPERTY_TRAIL,
      stored: TWO_PROPERTY_ROWS,
    });

    const result = await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(result.changed).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  /**
   * A visit still in progress has only grown. Its row is kept, so the office
   * correcting it does not find it gone between opening the dialog and saving.
   */
  it('lengthens the row of a visit that is still going instead of replacing it', async () => {
    const { service, tx } = harness({
      pings: at(0, 900, 5),
      stored: [row('seg-1', 'ONSITE', 'b1', 'insp-1', 0, 600)],
    });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(tx.timeSegment.update).toHaveBeenCalledWith({
      where: { id: 'seg-1' },
      data: { inspectionId: 'insp-1', endedAt: instant(900), durationSeconds: 900, quietSeconds: 0 },
    });
    expect(tx.timeSegment.createMany).not.toHaveBeenCalled();
    expect(tx.timeSegment.deleteMany).not.toHaveBeenCalled();
  });

  /** How the rows of the per-job reading, and any duplicate, leave the timesheet. */
  it('removes a row the day no longer calls for', async () => {
    const { service, tx } = harness({
      pings: at(0, 900, 5),
      stored: [
        row('seg-1', 'ONSITE', 'b1', 'insp-1', 0, 900),
        row('seg-twin', 'ONSITE', 'b1', 'insp-1', 0, 900),
        row('seg-old', 'DRIVING', 'b1', 'insp-1', 200, 400),
      ],
    });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(tx.timeSegment.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', technicianId: 'tech-1', id: { in: ['seg-twin', 'seg-old'] } },
    });
    expect(tx.timeSegment.createMany).not.toHaveBeenCalled();
  });

  it('only ever looks at rows the trail wrote, in this technician’s day', async () => {
    const { service, segments } = harness({ pings: at(0, 900, 5) });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    const stored = segments.mock.calls.map(([query]) => query.where).find((where) => !where.AND)!;
    expect(stored).toMatchObject({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      source: 'AUTOMATIC',
      adjustedAt: null,
    });
  });

  /**
   * Every silence used to be listed for the office to settle. It is counted
   * now, so a question still open about this day has been answered.
   */
  it('clears the open questions the per-job reading left about the day, and no settled one', async () => {
    const { service, tx } = harness({ pings: at(0, 900, 5), openGaps: 3 });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(tx.trackingGap.deleteMany.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      resolvedAt: null,
    });
  });

  /**
   * Two readings of one day at once would each see the same stored rows, each
   * decide what to add, and both add it: the same hour twice.
   */
  it('reads one technician’s day one reading at a time', async () => {
    let release: (fixes: unknown[]) => void = () => {};
    let reached = () => {};
    const inTheFirst = new Promise<void>((resolve) => (reached = resolve));
    let asked = 0;
    const { service, visits } = harness({
      pings: () => {
        asked += 1;
        if (asked > 1) return Promise.resolve([]);
        return new Promise<unknown[]>((resolve) => {
          release = resolve;
          reached();
        });
      },
    });

    const first = service.recomputeDay('org-1', 'tech-1', DAY, null);
    const second = service.recomputeDay('org-1', 'tech-1', DAY, null);
    await inTheFirst;

    // The second has not begun: it has not even asked which visits there are.
    expect(visits).toHaveBeenCalledTimes(1);
    release([]);
    await Promise.all([first, second]);
    expect(visits).toHaveBeenCalledTimes(2);
  });
});

/**
 * An hour a person has decided is no longer the trail's to answer.
 */
describe('hours somebody has corrected', () => {
  /**
   * The first version spared the corrected row and wrote the trail's version of
   * the same hour beside it: one correction and one recompute paid it twice.
   */
  it('does not write the trail’s version of an hour underneath a correction', async () => {
    const { service, tx } = harness({
      pings: at(0, 900, 5),
      decided: [{ startedAt: instant(0), endedAt: instant(600), adjustments: [] }],
    });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(created(tx)).toHaveLength(1);
    expect(created(tx)[0]).toMatchObject({ startedAt: instant(600), endedAt: instant(900) });
  });

  /**
   * Shortening a visit says the technician was not working for the rest of it.
   * The trail still says they were, and would put the time straight back.
   */
  it('does not give back the time a correction took away', async () => {
    const { service, transaction } = harness({
      pings: at(0, 900, 5),
      decided: [
        {
          startedAt: instant(0),
          endedAt: instant(300),
          adjustments: [{ beforeStartedAt: instant(0), beforeEndedAt: instant(900) }],
        },
      ],
    });

    const result = await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(result).toMatchObject({ changed: false, onsiteSeconds: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('asks for corrections and hand-credited time that touch the day', async () => {
    const { service, segments } = harness({ pings: at(0, 900, 5) });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    const decided = segments.mock.calls.map(([query]) => query.where).find((where) => where.AND)!;
    expect(decided.AND![0]).toEqual({ OR: [{ source: 'MANUAL' }, { adjustedAt: { not: null } }] });
  });
});

/**
 * The fixes are pruned after thirty days. A day read again after that finds no
 * trail at all, and must not conclude that nobody worked.
 */
describe('a day the trail is silent for', () => {
  it('keeps the hours already on it, and writes nothing', async () => {
    const { service, transaction, audit, segments } = harness({
      pings: [],
      stored: [row('seg-1', 'ONSITE', 'b1', 'insp-1', 0, 900)],
    });

    const result = await service.recomputeDay('org-1', 'tech-1', DAY, USER);

    expect(result).toMatchObject({ changed: false, fixesRead: 0 });
    expect(transaction).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    // Not even asked: there is nothing it could decide about them.
    expect(segments).not.toHaveBeenCalled();
  });

  /** One fix is still a trail, and the reading goes ahead on it. */
  it('still reads a day with any trail at all', async () => {
    const { service, segments } = harness({ pings: [ping(0, 5)] });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(segments).toHaveBeenCalled();
  });
});

describe('the audit trail', () => {
  it('says a person asked, when a person did', async () => {
    const { service, audit } = harness({ pings: at(0, 900, 5) });

    await service.recomputeDay('org-1', 'tech-1', DAY, USER);

    expect(audit.mock.calls[0]![0].data).toMatchObject({
      action: 'TIME_DAY_RECOMPUTED',
      actorUserId: 'admin-1',
      entityType: 'UserProfile',
      entityId: 'tech-1',
    });
  });

  /**
   * Two null actor columns already mean "no person", but they mean that for an
   * anonymous write too. The action name is what separates the two.
   */
  it('says nobody asked, under its own name, when nobody did', async () => {
    const { service, audit } = harness({ pings: at(0, 900, 5) });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(audit.mock.calls[0]![0].data).toMatchObject({
      action: 'TIME_DAY_RECOMPUTED_AUTOMATICALLY',
      actorUserId: null,
      actorApiClientId: null,
    });
  });

  it('records durations and counts, never where anybody was', async () => {
    const { service, audit } = harness({ pings: at(0, 900, 5) });

    await service.recomputeDay('org-1', 'tech-1', DAY, null);

    expect(audit.mock.calls[0]![0].data.metadata).toEqual({
      day: DAY,
      onsiteSeconds: 900,
      generalSeconds: 0,
      quietSeconds: 0,
      stretches: 1,
      properties: 1,
      fixesRead: 31,
      fixesDiscarded: 0,
    });
  });
});

describe('a reading nobody is waiting for', () => {
  /** A submission must not fail because its hours could not be read. */
  it('reports a failure and hands back nothing, instead of throwing', async () => {
    const { service } = harness({ pings: () => Promise.reject(new Error('database unreachable')) });

    await expect(service.recomputeDayAutomatically('org-1', 'tech-1', DAY)).resolves.toBeNull();
  });
});

/**
 * The office's button: how a change of rule reaches days already on the
 * timesheet.
 */
describe('recalculating a range', () => {
  const rangeHarness = (tracked: string[], timed: string[] = []) => {
    const built = harness();
    const prisma = built.prisma as unknown as {
      technicianLocationPing: { groupBy: jest.Mock };
      timeSegment: { groupBy: jest.Mock };
    };
    prisma.technicianLocationPing.groupBy.mockResolvedValue(tracked.map((technicianId) => ({ technicianId })));
    prisma.timeSegment.groupBy.mockResolvedValue(timed.map((technicianId) => ({ technicianId })));
    const read = jest
      .spyOn(built.service, 'recomputeDay')
      .mockImplementation((_organization, technicianId, day) =>
        Promise.resolve({
          day,
          technicianId,
          changed: day === '2026-10-02',
          onsiteSeconds: 0,
          generalSeconds: 0,
          fixesRead: 0,
          fixesDiscarded: 0,
        }),
      );
    return { ...built, read, prisma };
  };

  it('reads every day in the range for everybody with a trail or hours in it', async () => {
    const { service, read } = rangeHarness(['tech-1'], ['tech-1', 'tech-2']);

    const result = await service.recalculate(USER, { from: '2026-10-01', to: '2026-10-03' });

    expect(read.mock.calls.map(([, technicianId, day]) => `${technicianId} ${day}`)).toEqual([
      'tech-1 2026-10-01',
      'tech-1 2026-10-02',
      'tech-1 2026-10-03',
      'tech-2 2026-10-01',
      'tech-2 2026-10-02',
      'tech-2 2026-10-03',
    ]);
    expect(result).toEqual({ days: 3, technicians: 2, changed: 2 });
  });

  it('does it as the person who asked, inside their own organization', async () => {
    const { service, read, prisma } = rangeHarness(['tech-1']);

    await service.recalculate(USER, { from: '2026-10-01', to: '2026-10-01' });

    expect(read).toHaveBeenCalledWith('org-1', 'tech-1', '2026-10-01', USER);
    expect(prisma.technicianLocationPing.groupBy.mock.calls[0]![0].where.organizationId).toBe('org-1');
    expect(prisma.timeSegment.groupBy.mock.calls[0]![0].where.organizationId).toBe('org-1');
  });

  /** The trail is kept for thirty days. There is nothing older to read. */
  it('refuses more than a month at a time', async () => {
    const { service, read } = rangeHarness(['tech-1']);

    await expect(service.recalculate(USER, { from: '2026-08-01', to: '2026-10-01' })).rejects.toThrow(
      /up to 31 days/,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a range that runs backwards', async () => {
    const { service } = rangeHarness(['tech-1']);

    await expect(service.recalculate(USER, { from: '2026-10-03', to: '2026-10-01' })).rejects.toThrow(
      /before the first/,
    );
  });
});
