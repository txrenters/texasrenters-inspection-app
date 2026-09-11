import { TechnicianLocationService } from '../src/technician/technician-location.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * One technician, one marker.
 *
 * Reported from the console: the technician marker duplicates — two pins and
 * two accuracy rings for one person, a few metres apart.
 *
 * `latestPositions` asks for the rows matching `(technicianId, newest
 * recordedAt)`, and **that pair is not unique**. Handsets here emit two fixes
 * bearing the identical millisecond in roughly two per cent of reports:
 * genuinely different readings, twenty metres and a few metres of accuracy
 * apart, arriving in the same batch. When the tie lands on somebody's most
 * recent fix, both rows come back and the map draws both.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const decimal = (value: number) => ({ toNumber: () => value });

const ping = (over: Record<string, unknown> = {}) => ({
  id: 'ping-a',
  technicianId: 'tech-1',
  latitude: decimal(30.015878),
  longitude: decimal(-95.602839),
  accuracyMeters: 38,
  batteryPercent: null,
  headingDegrees: null,
  speedMetersPerSecond: null,
  recordedAt: new Date('2026-09-11T20:43:22.995Z'),
  technician: { id: 'tech-1', displayName: 'Moses Rodriguez' },
  ...over,
});

function build(rows: ReturnType<typeof ping>[]) {
  const prisma = {
    technicianLocationPing: {
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { technicianId: 'tech-1', _max: { recordedAt: rows[0].recordedAt } },
        ]),
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
  return new TechnicianLocationService(prisma as never);
}

describe('the latest position of each technician', () => {
  it('is one row even when two fixes claim the same instant', async () => {
    // The exact pair from production, twenty-two metres apart.
    const positions = await build([
      ping({ id: 'ping-a', accuracyMeters: 38, latitude: decimal(30.015878) }),
      ping({ id: 'ping-b', accuracyMeters: 33, latitude: decimal(30.016079) }),
    ]).latestPositions(user);

    expect(positions).toHaveLength(1);
  });

  it('keeps the more precise of the two', async () => {
    /**
     * If two fixes describe the same instant, the tighter one is the better
     * claim about where somebody actually is. Taking whichever the database
     * happened to return first would put the marker on the worse reading half
     * the time, for no reason anybody could see.
     */
    const positions = await build([
      ping({ id: 'ping-a', accuracyMeters: 38 }),
      ping({ id: 'ping-b', accuracyMeters: 33 }),
    ]).latestPositions(user);

    expect(positions[0].accuracyMeters).toBe(33);
  });

  it('chooses the same row every time when accuracy also ties', async () => {
    // Otherwise the marker flickers between two positions on every poll, which
    // reads as a technician twitching back and forth across the street.
    const rows = [ping({ id: 'ping-b' }), ping({ id: 'ping-a' })];
    const first = await build(rows).latestPositions(user);
    const second = await build([...rows].reverse()).latestPositions(user);

    expect(first[0].id).toBe(second[0].id);
  });

  it('prefers a fix that reports accuracy over one that does not', async () => {
    // A handset that will not say how precise it is has made the weaker claim.
    const positions = await build([
      ping({ id: 'ping-a', accuracyMeters: null }),
      ping({ id: 'ping-b', accuracyMeters: 40 }),
    ]).latestPositions(user);

    expect(positions[0].accuracyMeters).toBe(40);
  });

  it('still returns everybody who reported', async () => {
    const service = build([
      ping({ id: 'ping-a', technicianId: 'tech-1' }),
      ping({ id: 'ping-b', technicianId: 'tech-2' }),
    ]);
    const positions = await service.latestPositions(user);

    expect(positions.map((row) => row.technicianId).sort()).toEqual(['tech-1', 'tech-2']);
  });
});
