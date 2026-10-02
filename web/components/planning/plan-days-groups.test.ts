import { describe, expect, it } from 'vitest';

import type { PlanDay, PlanDayRoute } from '@/lib/planning-queries';

import { legEnds } from './group-file';
import type { DayStop } from './plan-day-groups';
import { dayRouteView, planDaysFile } from './plan-days-groups';

/**
 * The Days view drawn as the Group maker draws a template (the office,
 * 2026-10-02): each day a group, its route from the technician's home.
 */

const visitOnDay = (id: string, positionInDay: number, latitude: number, drive: number | null, status = 'PLANNED') => ({
  id,
  buildingId: `b-${id}`,
  sequence: positionInDay,
  positionInDay,
  inspectionType: 'OCCUPIED' as const,
  onSiteMinutes: 30,
  driveSecondsForecast: drive,
  zone: '1',
  status: status as PlanDay['stops'][number]['status'],
  address: `${id} Main St`,
  city: 'Katy',
  latitude,
  longitude: -95.7,
});

const day = (overrides: Partial<PlanDay> = {}): PlanDay => ({
  id: 'day-1',
  date: '2026-12-17T00:00:00.000Z',
  technicianId: 'tech-1',
  technician: { id: 'tech-1', displayName: 'Moses Rivera' },
  stopCount: 2,
  onSiteMinutes: 120,
  hvacStopCount: 0,
  totalDriveSeconds: 900,
  totalDriveMeters: 9000,
  homeDriveSeconds: 1500,
  homeDriveMeters: 20000,
  originKind: 'HOME',
  durationSource: 'MAPBOX_FREE_FLOW',
  departureAssumedAt: null,
  templateGroup: null,
  // A move-out between the two visits: it is on the day's road.
  stops: [visitOnDay('s1', 1, 29.7, null), visitOnDay('s3', 3, 29.72, 600, 'PUBLISHED')],
  anchors: [
    {
      id: 'a1',
      inspectionId: 'mo-1',
      buildingId: 'b-mo',
      kind: 'MOVE_OUT',
      positionInDay: 2,
      onSiteMinutes: 60,
      driveSecondsForecast: 300,
      address: 'Move-out Ln',
      city: 'Katy',
      latitude: 29.71,
      longitude: -95.7,
      assignedTechnician: { id: 'tech-1', displayName: 'Moses Rivera' },
      scheduledOn: '2026-12-17',
      cancelled: false,
    },
  ],
  ...overrides,
});

const noDay = (id: string, status = 'PLANNED'): DayStop => ({
  id,
  latitude: 29.9,
  longitude: -95.6,
  scheduledOn: null,
  positionInDay: null,
  technician: null,
  zone: '2',
  address: `${id} Elm St`,
  unit: null,
  city: 'Cypress',
  postalCode: '77429',
  lease: `Lease ${id}`,
  hvacPlan: null,
  status,
});

describe('a quarter’s days as the Group maker’s groups', () => {
  it('keeps a day’s move-out on its road, in driving order', () => {
    const { file } = planDaysFile([day()], []);

    expect(file.groups[0]!.rows.map((row) => row.address)).toEqual(['s1 Main St', 'Move-out Ln', 's3 Main St']);
    expect(file.groups[0]!.rows.map((row) => row.stop)).toEqual([1, 2, 3]);
    expect(file.groups[0]!.name).toBe('Dec 17 · Moses Rivera');
  });

  it('says what each property is, for a click on it', () => {
    const { file, entries } = planDaysFile([day()], [noDay('s9')]);
    const of = (address: string) =>
      entries.get([...file.groups[0]!.rows, ...file.ungrouped].find((row) => row.address === address)!.rowNumber);

    expect(of('s1 Main St')).toMatchObject({ kind: 'visit', stopId: 's1', dayId: 'day-1', booked: false });
    expect(of('s3 Main St')).toMatchObject({ kind: 'visit', stopId: 's3', booked: true, technicianId: 'tech-1' });
    expect(of('Move-out Ln')).toMatchObject({ kind: 'booking', dayId: 'day-1' });
    expect(of('s9 Elm St')).toMatchObject({ kind: 'visit', stopId: 's9', dayId: null, booked: false });
  });

  it('draws a visit with no day apart, and never one the office left out', () => {
    const { file } = planDaysFile([day()], [noDay('s9'), noDay('s10', 'EXCLUDED')]);

    expect(file.ungrouped.map((row) => row.address)).toEqual(['s9 Elm St']);
    expect(file.ungrouped[0]!.lease).toBe('Lease s9');
  });

  it('colours a day built from a template in its template group’s colour', () => {
    const { file } = planDaysFile(
      [day({ templateGroup: { id: 'g-37', position: 37, name: 'Group 37', color: '#7f77dd' } })],
      [],
    );

    expect(file.groups[0]!.color.fill).toBe('#7f77dd');
  });
});

describe('a day’s road, as the map draws a group’s', () => {
  const route: PlanDayRoute = {
    source: 'MAPBOX_FREE_FLOW',
    homeGeometry: [
      [29.6, -95.7],
      [29.7, -95.7],
    ],
    geometry: [
      [29.7, -95.7],
      [29.71, -95.7],
      [29.72, -95.7],
    ],
    home: { latitude: 29.6, longitude: -95.7, address: 'Spring, TX' },
    legs: [
      { durationSeconds: 240, distanceMeters: 1100 },
      { durationSeconds: 500, distanceMeters: 1200 },
    ],
  };
  const home = { latitude: 29.6, longitude: -95.7 };

  it('starts at home, with each leg’s drive as the plan has it, and counts only the driving between properties', () => {
    const made = planDaysFile([day()], []);
    const view = dayRouteView(day(), made.file.groups[0]!, route, home);

    expect(view.status).toBe('ok');
    if (view.status !== 'ok') return;
    // From home first, then into the move-out and into the last visit: the plan's seconds, the road's metres.
    expect(view.route.legs).toEqual([
      { durationS: 1500, distanceM: 20000 },
      { durationS: 300, distanceM: 1100 },
      { durationS: 600, distanceM: 1200 },
    ]);
    expect(view.route.durationS).toBe(900);
    expect(view.route.splits).toHaveLength(4);
  });

  it('draws the stops joined straight while the road is not one of this order', () => {
    const made = planDaysFile([day()], []);

    expect(dayRouteView(day(), made.file.groups[0]!, { ...route, legs: route.legs.slice(1) }, home).status).toBe('error');
    expect(dayRouteView(day(), made.file.groups[0]!, undefined, home).status).toBe('loading');
  });
});

describe('where a leg runs', () => {
  const rows = [1, 2, 3].map((stop) => ({ stop, latitude: 29.7 + stop / 100, longitude: -95.7 }) as never);

  it('starts at the origin when a group has one', () => {
    const origin = { latitude: 29.6, longitude: -95.7, title: 'From: home' };

    expect(legEnds({ rows, origin }, 0)).toMatchObject({ from: origin, fromStop: 'Home', toStop: 1 });
    expect(legEnds({ rows, origin }, 2)).toMatchObject({ fromStop: 2, toStop: 3 });
  });

  it('runs from stop to stop when it has none', () => {
    expect(legEnds({ rows, origin: null }, 0)).toMatchObject({ fromStop: 1, toStop: 2 });
    expect(legEnds({ rows }, 1)).toMatchObject({ fromStop: 2, toStop: 3 });
  });
});

/** The office (2026-10-03): "let's not modify the groupings label, it should stay the same as is". */
describe('a day built from a template group, on the Days list', () => {
  const group = { id: null, position: 37, name: 'Katy North', color: '#7f77dd' };

  it('is labelled with the group’s number, not its place in the quarter', () => {
    const { file } = planDaysFile([day({ templateGroup: group })], []);

    expect(file.groups[0]!.label).toBe('37');
  });

  it('labels the quarter’s other days N1, N2, in the order it is worked', () => {
    const { file } = planDaysFile(
      [
        day({ id: 'day-1', date: '2026-12-17T00:00:00.000Z', templateGroup: group }),
        day({ id: 'day-2', date: '2026-12-18T00:00:00.000Z', templateGroup: null }),
        day({ id: 'day-3', date: '2026-12-21T00:00:00.000Z', templateGroup: { ...group, position: 4 } }),
        day({ id: 'day-4', date: '2026-12-22T00:00:00.000Z', templateGroup: null }),
      ],
      [],
    );

    expect(file.groups.map((one) => one.label)).toEqual(['37', 'N1', '4', 'N2']);
  });

  it('numbers a quarter with no template day 1, 2, 3, as before', () => {
    const { file } = planDaysFile(
      [day({ id: 'day-1' }), day({ id: 'day-2', date: '2026-12-18T00:00:00.000Z' }), day({ id: 'day-3', date: '2026-12-21T00:00:00.000Z' })],
      [],
    );

    expect(file.groups.map((one) => one.label)).toEqual(['1', '2', '3']);
  });
});
