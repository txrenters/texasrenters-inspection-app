import { TimeSegmentSource } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TimeTrackingService } from '../src/time-tracking/time-tracking.service';

/**
 * Reading a technician's trail as the time a job took.
 *
 * The arithmetic is pinned in `shared/tests/time-segments.test.ts`. What is
 * pinned here is everything around it: which of its answers belong to this job,
 * what a recompute is allowed to overwrite, and what it refuses to do when the
 * trail cannot answer.
 */

const USER = {
  id: 'admin-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const PROPERTY = { latitude: 29.76, longitude: -95.37 };
const METRE = 1 / 111_320;
const START = Date.UTC(2026, 8, 23, 14, 0, 0);

const ping = (seconds: number, metresNorth: number, speed: number | null = 0, accuracy = 5) => ({
  latitude: PROPERTY.latitude + metresNorth * METRE,
  longitude: PROPERTY.longitude,
  accuracyMeters: accuracy,
  speedMetersPerSecond: speed,
  recordedAt: new Date(START + seconds * 1000),
});

/** A stretch at one place, one fix every thirty seconds as the recorder makes them. */
const at = (fromSeconds: number, forSeconds: number, metresNorth: number, speed: number | null = 0) =>
  Array.from({ length: Math.floor(forSeconds / 30) + 1 }, (_, index) =>
    ping(fromSeconds + index * 30, metresNorth, speed),
  );

const harness = (
  pings: ReturnType<typeof ping>[],
  overrides: { geofence?: unknown; building?: unknown; technicianId?: string | null } = {},
) => {
  const createSegments = jest.fn().mockResolvedValue({ count: 0 });
  const deleteSegments = jest.fn().mockResolvedValue({ count: 0 });
  const createGaps = jest.fn().mockResolvedValue({ count: 0 });
  const deleteGaps = jest.fn().mockResolvedValue({ count: 0 });
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    timeSegment: { deleteMany: deleteSegments, createMany: createSegments },
    trackingGap: { deleteMany: deleteGaps, createMany: createGaps },
  };
  const building =
    overrides.building === undefined
      ? {
          id: 'b1',
          latitude: PROPERTY.latitude,
          longitude: PROPERTY.longitude,
          geofence: overrides.geofence ?? null,
        }
      : overrides.building;
  const prisma = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'insp-1',
        startedAt: new Date(START),
        submittedAt: new Date(START + 7_200_000),
        scheduledAt: new Date(START),
        propertywareBuilding: building,
        assignments:
          overrides.technicianId === null ? [] : [{ technicianId: overrides.technicianId ?? 'tech-1' }],
      }),
    },
    technicianLocationPing: { findMany: jest.fn().mockResolvedValue(pings) },
    auditLog: { create: auditCreate },
    $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaService;
  return {
    service: new TimeTrackingService(prisma),
    createSegments,
    deleteSegments,
    createGaps,
    deleteGaps,
    auditCreate,
  };
};

const categories = (createSegments: jest.Mock): string[] =>
  (createSegments.mock.calls[0]?.[0]?.data ?? []).map((row: { category: string }) => row.category);

describe('reading a job from the trail', () => {
  it('records the time the technician was at the property', async () => {
    const { service, createSegments } = harness([...at(0, 300, 500, 12), ...at(330, 3_600, 5)]);

    const result = await service.recomputeForInspection(USER, 'insp-1');

    expect(categories(createSegments)).toContain('ONSITE');
    expect(result.onsiteSeconds).toBeGreaterThan(3_400);
  });

  /**
   * The case the office described: property, supplier, property. The trip out
   * and back sits between two of this job's own visits, so it is this job's.
   */
  it('keeps a trip to the supplier that happened during the visit', async () => {
    const { service, createSegments } = harness([
      ...at(0, 900, 5),
      ...at(960, 600, 4_000, 15),
      ...at(1_620, 900, 8_000, 0),
      ...at(2_580, 600, 4_000, 15),
      ...at(3_240, 900, 5),
    ]);

    await service.recomputeForInspection(USER, 'insp-1');

    expect(categories(createSegments)).toEqual(['ONSITE', 'DRIVING', 'GENERAL', 'DRIVING', 'ONSITE']);
  });

  /**
   * The judgement this service makes, and the one worth arguing with.
   *
   * A technician driving to the first job of the day is driving for that job,
   * or the last one, or neither -- answering it properly needs the whole day's
   * schedule. Attributing it here would put somebody else's travel on this
   * invoice, so travel before the first arrival and after the last departure is
   * left out. It is still in the trail, and something that knows the day can
   * attribute it later.
   */
  it('leaves travel before arriving and after leaving off this job', async () => {
    const { service, createSegments } = harness([
      ...at(0, 900, 6_000, 15),   // driving in, before the visit
      ...at(960, 1_800, 5),        // the visit
      ...at(2_820, 900, 6_000, 15),// driving away afterwards
    ]);

    await service.recomputeForInspection(USER, 'insp-1');

    expect(categories(createSegments)).toEqual(['ONSITE']);
  });

  it('reports what the buttons said beside what the trail said', async () => {
    const { service } = harness([...at(0, 300, 500, 12), ...at(330, 1_800, 5)]);

    const result = await service.recomputeForInspection(USER, 'insp-1');

    // Start at 14:00, End two hours later, whatever the technician was doing.
    expect(result.manualSeconds).toBe(7_200);
    expect(result.onsiteSeconds).toBeLessThan(result.manualSeconds!);
  });
});

describe('what a recompute may overwrite', () => {
  /**
   * An administrator corrected a segment because the trail was wrong about it.
   * Re-deriving would undo that correction every time this ran, which would
   * make the correction worthless and the tracker untrustworthy.
   */
  it('replaces its own previous answer but never an adjusted segment', async () => {
    const { service, deleteSegments } = harness([...at(0, 1_800, 5)]);

    await service.recomputeForInspection(USER, 'insp-1');

    expect(deleteSegments).toHaveBeenCalledWith({
      where: {
        inspectionId: 'insp-1',
        organizationId: 'org-1',
        source: TimeSegmentSource.AUTOMATIC,
        adjustedAt: null,
      },
    });
  });

  it('leaves a gap somebody has already settled alone', async () => {
    const { service, deleteGaps } = harness([...at(0, 1_800, 5)]);

    await service.recomputeForInspection(USER, 'insp-1');

    expect(deleteGaps).toHaveBeenCalledWith({
      where: { inspectionId: 'insp-1', organizationId: 'org-1', resolvedAt: null },
    });
  });

  it('audits the counts, and never the coordinates', async () => {
    const { service, auditCreate } = harness([...at(0, 1_800, 5)]);

    await service.recomputeForInspection(USER, 'insp-1');

    const audited = auditCreate.mock.calls[0]![0].data;
    expect(audited.action).toBe('TIME_SEGMENTS_RECOMPUTED');
    expect(Object.keys(audited.metadata)).toEqual([
      'segments',
      'onsiteSeconds',
      'gaps',
      'fixesRead',
      'fixesDiscarded',
    ]);
  });
});

describe('when the trail cannot answer', () => {
  /**
   * Five of 589 active properties are not rooftop-geocoded. Measuring time
   * against a pin that is a guess along a street would bill somebody for
   * standing in the wrong place, so it refuses and says what to fix.
   */
  it('refuses a property with no coordinates rather than guessing', async () => {
    const { service } = harness([...at(0, 1_800, 5)], {
      building: { id: 'b1', latitude: null, longitude: null, geofence: null },
    });

    await expect(service.recomputeForInspection(USER, 'insp-1')).rejects.toThrow(/coordinates/);
  });

  it('refuses a job with nobody assigned', async () => {
    const { service } = harness([...at(0, 1_800, 5)], { technicianId: null });

    await expect(service.recomputeForInspection(USER, 'insp-1')).rejects.toThrow(/nobody assigned/);
  });

  it('writes nothing at all from a trail with no fixes', async () => {
    const { service, createSegments } = harness([]);

    const result = await service.recomputeForInspection(USER, 'insp-1');

    expect(result.segments).toEqual([]);
    expect(createSegments).not.toHaveBeenCalled();
  });

  /** A property's own pin is overridden where somebody has corrected it. */
  it('prefers a corrected pin over the building the geocoder placed', async () => {
    const { service, createSegments } = harness([...at(0, 1_800, 300)], {
      // The real property is 300 m north of where the geocoder put it.
      geofence: {
        latitude: PROPERTY.latitude + 300 * METRE,
        longitude: PROPERTY.longitude,
        enterRadiusMeters: 40,
        exitRadiusMeters: 60,
      },
    });

    await service.recomputeForInspection(USER, 'insp-1');

    expect(categories(createSegments)).toContain('ONSITE');
  });
});

/**
 * The same recompute, with nobody behind it.
 *
 * Runs when a technician submits and again from the sweep, so the office never
 * has to remember to ask. Two things make it different from the request-driven
 * one, and both matter on a table somebody is paid from: it reports rather
 * than throws, and the audit says which of the two it was.
 */
describe('recomputing without a person', () => {
  it('reads the job and writes its segments', async () => {
    const { service, createSegments } = harness([...at(0, 300, 500, 12), ...at(330, 3_600, 5)]);

    const result = await service.recomputeAutomatically('org-1', 'insp-1');

    expect(result?.onsiteSeconds).toBeGreaterThan(0);
    expect(categories(createSegments)).toContain('ONSITE');
  });

  /**
   * Never mistakable for somebody's decision.
   *
   * Two null actor columns already mean "no person", but they mean that for an
   * anonymous write too. The action name is what separates a recompute an
   * administrator asked for from one that simply happened.
   */
  it('audits itself as automatic, with no actor', async () => {
    const { service, auditCreate } = harness([...at(0, 3_600, 5)]);

    await service.recomputeAutomatically('org-1', 'insp-1');

    expect(auditCreate.mock.calls[0]![0].data).toMatchObject({
      action: 'TIME_SEGMENTS_RECOMPUTED_AUTOMATICALLY',
      actorUserId: null,
      actorApiClientId: null,
    });
  });

  it('still names the person when one asked for it', async () => {
    const { service, auditCreate } = harness([...at(0, 3_600, 5)]);

    await service.recomputeForInspection(USER, 'insp-1');

    expect(auditCreate.mock.calls[0]![0].data).toMatchObject({
      action: 'TIME_SEGMENTS_RECOMPUTED',
      actorUserId: 'admin-1',
    });
  });

  /**
   * A job that cannot be measured is an ordinary fact, not an emergency.
   *
   * The request-driven path tells an administrator why, because they asked.
   * Thrown from a sweep it would stop every job behind it in the list, which
   * is other people's hours.
   */
  it('reports rather than throws when the property has no coordinates', async () => {
    const { service } = harness([...at(0, 3_600, 5)], {
      building: { id: 'b1', latitude: null, longitude: null, geofence: null },
    });

    await expect(service.recomputeAutomatically('org-1', 'insp-1')).resolves.toBeNull();
  });

  it('reports rather than throws when nobody is assigned', async () => {
    const { service } = harness([...at(0, 3_600, 5)], { technicianId: null });

    await expect(service.recomputeAutomatically('org-1', 'insp-1')).resolves.toBeNull();
  });

  it('writes nothing when it could not measure', async () => {
    const { service, createSegments } = harness([...at(0, 3_600, 5)], { technicianId: null });

    await service.recomputeAutomatically('org-1', 'insp-1');

    expect(createSegments).not.toHaveBeenCalled();
  });
});
