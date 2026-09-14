import type { AssignedStop, TechnicianDayTimeline } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { historyTotals, listDay, visitTimes } from './route-plan';

/**
 * A technician's day as the map's list reads it: what is done, where they are,
 * what is next -- and what the finished part of the day actually took.
 */

const stop = (id: string, status: string, finishedAt: string | null = null): AssignedStop => ({
  inspectionId: id,
  buildingId: `building-${id}`,
  propertyName: `${id} address`,
  inspectionType: 'OCCUPIED',
  status,
  finishedAt,
});

const route = (ids: string[]) =>
  ({
    stops: ids.map((id) => ({ inspectionId: id })),
    legs: ids.map((id) => ({ toStopId: id, durationSeconds: 300, distanceMeters: 1000 })),
    unroutable: [],
  }) as never;

const timeline = (stops: TechnicianDayTimeline['stops']) => ({ stops }) as TechnicianDayTimeline;

describe('listing a day', () => {
  const stops = [
    stop('later-done', 'COMPLETED', '2026-09-14T17:00:00Z'),
    stop('ahead', 'SCHEDULED'),
    stop('here', 'IN_PROGRESS'),
    stop('earlier-done', 'TECHNICIAN_SUBMITTED', '2026-09-14T15:00:00Z'),
    stop('next', 'SCHEDULED'),
  ];

  it('puts finished stops first, in the order they were handed in, then the route order', () => {
    const listing = listDay(stops, route(['here', 'next', 'ahead']), ['here']);
    expect(listing.map((entry) => [entry.stop.inspectionId, entry.role])).toEqual([
      ['earlier-done', 'FINISHED'],
      ['later-done', 'FINISHED'],
      ['here', 'CURRENT'],
      ['next', 'NEXT'],
      ['ahead', 'AHEAD'],
    ]);
  });

  it('numbers stops by their place in the route, not by their place in the list', () => {
    const listing = listDay(stops, route(['here', 'next', 'ahead']), ['here']);
    expect(listing.find((entry) => entry.stop.inspectionId === 'next')?.routeIndex).toBe(1);
    expect(listing.find((entry) => entry.stop.inspectionId === 'earlier-done')?.routeIndex).toBeNull();
  });

  it('sorts a finished stop with no time after the ones that have one', () => {
    const listing = listDay(
      [stop('no-time', 'COMPLETED'), stop('timed', 'COMPLETED', '2026-09-14T15:00:00Z')],
      null,
      null,
    );
    expect(listing.map((entry) => entry.stop.inspectionId)).toEqual(['timed', 'no-time']);
  });

  it('calls nothing next when there is no route to order the day by', () => {
    const listing = listDay(stops, null, null);
    expect(listing.some((entry) => entry.role === 'NEXT')).toBe(false);
  });
});

describe('what the finished visits took', () => {
  it('gives the drive, the time on site and both, from the trail', () => {
    expect(
      visitTimes(
        timeline([
          {
            buildingId: 'b',
            propertyName: 'b',
            inspectionIds: ['done'],
            onSiteSeconds: 2520,
            driveToSeconds: 720,
          },
        ]),
        'done',
      ),
    ).toEqual({ driveSeconds: 720, onSiteSeconds: 2520, totalSeconds: 3240 });
  });

  it('claims no time for a visit the trail never saw', () => {
    expect(
      visitTimes(
        timeline([
          { buildingId: 'b', propertyName: 'b', inspectionIds: ['done'], onSiteSeconds: 0, driveToSeconds: null },
        ]),
        'done',
      ),
    ).toBeNull();
  });

  it('adds each place once, however many inspections were handed in at it', () => {
    const stops = [
      stop('unit-1', 'COMPLETED', '2026-09-14T15:00:00Z'),
      stop('unit-2', 'COMPLETED', '2026-09-14T15:05:00Z'),
      stop('ahead', 'SCHEDULED'),
    ];
    const day = timeline([
      {
        buildingId: 'shared-building',
        propertyName: 'x',
        inspectionIds: ['unit-1', 'unit-2'],
        onSiteSeconds: 1800,
        driveToSeconds: 600,
      },
    ]);

    expect(historyTotals(day, listDay(stops, null, null))).toEqual({
      finished: 2,
      measured: 1,
      driveSeconds: 600,
      onSiteSeconds: 1800,
      totalSeconds: 2400,
    });
  });
});
