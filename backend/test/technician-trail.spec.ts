import { AdminController } from '../src/admin/admin.controller';
import { TechnicianTimelineService } from '../src/technician/technician-timeline.service';

/**
 * Where a technician actually went, as lines for the technician map (the
 * office, 2026-10-02: "add ... the trailing lines").
 *
 * The same fixes the day timeline reads, so the same boundaries: one
 * organization, one technician, one Texas day -- and the same grant as the
 * live position, because a day's path is the same fact about a person.
 */

const dec = (value: number) => ({ toNumber: () => value }) as never;

const ping = (latitude: number, iso: string, accuracyMeters: number | null = 8) => ({
  latitude: dec(latitude),
  longitude: dec(-95.37),
  recordedAt: new Date(iso),
  accuracyMeters,
});

describe('TechnicianTimelineService.trailFor', () => {
  const user = { id: 'office-user', organizationId: 'org-1' } as never;

  it('reads one technician, one organization and one Texas day', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new TechnicianTimelineService(
      { technicianLocationPing: { findMany }, timeSegment: { findMany: jest.fn().mockResolvedValue([]) } } as never,
      {} as never,
    );

    await service.trailFor(user, 'tech-1', new Date('2026-10-02T12:00:00.000Z'));

    const query = findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      // 2 October in Texas (CDT): 05:00Z to 05:00Z.
      recordedAt: {
        gte: new Date('2026-10-02T05:00:00.000Z'),
        lt: new Date('2026-10-03T05:00:00.000Z'),
      },
    });
    // Accuracy is read so a vague fix can be left off the line.
    expect(query.select).toEqual({
      latitude: true,
      longitude: true,
      recordedAt: true,
      accuracyMeters: true,
    });
    expect(query.orderBy).toEqual({ recordedAt: 'asc' });
  });

  it('hands back the day as lines, without the vague fix, broken where the phone went quiet', async () => {
    const service = new TechnicianTimelineService(
      {
        technicianLocationPing: {
          findMany: async () => [
            ping(29.76, '2026-10-02T14:00:00.000Z'),
            ping(29.762, '2026-10-02T14:01:00.000Z'),
            // Indoors: claims to be within 600m, so it is not drawn.
            ping(29.765, '2026-10-02T14:02:00.000Z', 600),
            ping(29.764, '2026-10-02T14:03:00.000Z', null),
            // Twenty minutes of silence and five kilometres away.
            ping(29.81, '2026-10-02T14:23:00.000Z'),
            ping(29.812, '2026-10-02T14:24:00.000Z'),
          ],
        },
        timeSegment: { findMany: async () => [] },
      } as never,
      {} as never,
    );

    const trail = await service.trailFor(user, 'tech-1', new Date('2026-10-02T12:00:00.000Z'));

    expect(trail.technicianId).toBe('tech-1');
    expect(trail.fixes).toBe(6);
    expect(trail.segments).toHaveLength(2);
    expect(trail.segments[0]!.points).toEqual([
      [29.76, -95.37],
      [29.764, -95.37],
    ]);
    expect(trail.segments[1]!.startedAt).toBe('2026-10-02T14:23:00.000Z');
  });

  /**
   * The timesheet's own stops (the office, 2026-10-17: "show it on the map"),
   * so the map and the hours agree about where and for how long.
   */
  it('hands back the day’s stops away from the properties, as the timesheet counts them', async () => {
    const stops = jest.fn().mockResolvedValue([
      {
        id: 'stop-1',
        startedAt: new Date('2026-10-02T15:40:00.000Z'),
        endedAt: new Date('2026-10-02T16:05:00.000Z'),
        durationSeconds: 1_500,
        placeLatitude: dec(29.9),
        placeLongitude: dec(-95.5),
        placeKind: 'BUSINESS',
        placeName: 'The Home Depot',
        placeAddress: '1 Supply Rd, Houston',
      },
    ]);
    const service = new TechnicianTimelineService(
      { technicianLocationPing: { findMany: async () => [] }, timeSegment: { findMany: stops } } as never,
      {} as never,
    );

    const trail = await service.trailFor(user, 'tech-1', new Date('2026-10-02T12:00:00.000Z'));

    expect(stops.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      technicianId: 'tech-1',
      category: 'STOP',
      startedAt: { gte: new Date('2026-10-02T05:00:00.000Z'), lt: new Date('2026-10-03T05:00:00.000Z') },
      // One whose position went with the trail has nowhere to be drawn.
      placeLatitude: { not: null },
      placeLongitude: { not: null },
    });
    expect(trail.stops).toEqual([
      {
        id: 'stop-1',
        startedAt: '2026-10-02T15:40:00.000Z',
        endedAt: '2026-10-02T16:05:00.000Z',
        durationSeconds: 1_500,
        latitude: 29.9,
        longitude: -95.5,
        kind: 'BUSINESS',
        name: 'The Home Depot',
        address: '1 Supply Rd, Houston',
      },
    ]);
  });
});

describe('GET admin/technicians/:technicianId/trail', () => {
  it('is behind the live-position grant, not the directory one', () => {
    const handler = AdminController.prototype.technicianTrail as unknown as object;
    expect(Reflect.getMetadata('permissions', handler)).toEqual(['technicians:locate']);
    expect(Reflect.getMetadata('path', handler)).toBe('technicians/:technicianId/trail');
  });
});
