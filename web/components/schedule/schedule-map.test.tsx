import type { PropertyPosition, TechnicianRoute } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dayRuns, ScheduleMap } from './schedule-map';

/**
 * The map beside the Schedule (the office, 2026-11-05): only the shown day's
 * properties, and each technician's day along the roads -- the routes the
 * technician map keeps -- rather than stops joined straight. Places invented.
 */

const seen = vi.hoisted(() => ({
  portfolio: null as null | { properties: readonly { id: string }[] },
  routes: [] as { ids: readonly string[]; date: string; enabled: boolean }[],
  locate: true,
  routeData: [] as unknown[],
}));

vi.mock('@/components/console-map', () => ({
  ConsoleMap: ({ portfolio }: { portfolio: { properties: readonly { id: string }[] } }) => {
    seen.portfolio = portfolio;
    return <div>the map</div>;
  },
}));
vi.mock('react-map-gl/mapbox', () => ({
  Layer: () => null,
  Marker: () => null,
  Source: () => null,
  useMap: () => ({ current: null }),
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => key !== 'technicians:locate' || seen.locate }) }));

const place = (id: string, latitude: number, longitude: number) =>
  ({ id, latitude, longitude, name: id, tbpEnrolled: true }) as unknown as PropertyPosition;
const PLACES = [place('b-1', 29.9, -95.6), place('b-2', 29.8, -95.5), place('b-3', 29.7, -95.4), place('b-far', 30.4, -95.9)];
const DAY = [
  { technicianId: 'tech-a', displayName: 'Ada Lane', stops: [{ buildingId: 'b-1' }, { buildingId: 'b-2' }] },
  { technicianId: 'tech-z', displayName: 'Zoe Park', stops: [{ buildingId: 'b-3' }, { buildingId: null }] },
];

vi.mock('@/lib/queries', () => ({
  useMapAssignments: () => ({ data: DAY, isLoading: false }),
  usePropertyLocations: () => ({ data: PLACES }),
  useTechnicianRoutes: (ids: readonly string[], date: string, enabled: boolean) => {
    seen.routes.push({ ids, date, enabled });
    return seen.routeData;
  },
}));

const route = (technicianId: string, driven: [number, number][], ahead: [number, number][]) =>
  ({ technicianId, geometry: ahead, history: { stops: [], geometry: driven } }) as unknown as TechnicianRoute;

beforeEach(() => {
  seen.portfolio = null;
  seen.routes = [];
  seen.locate = true;
  seen.routeData = [];
});

describe('the Schedule map', () => {
  it("draws only the day's properties, not the rest of the portfolio", () => {
    render(<ScheduleMap date="2026-11-02" />);
    expect(seen.portfolio?.properties.map((property) => property.id).sort()).toEqual(['b-1', 'b-2', 'b-3']);
  });

  it("reads the day's saved routes once per technician on it, and only with technicians:locate", () => {
    render(<ScheduleMap date="2026-11-02" />);
    expect(seen.routes.at(-1)).toEqual({ ids: ['tech-a', 'tech-z'], date: '2026-11-02', enabled: true });

    seen.locate = false;
    render(<ScheduleMap date="2026-11-02" />);
    expect(seen.routes.at(-1)?.enabled).toBe(false);
  });

  it('says where the routes start once one is drawn', () => {
    seen.routeData = [route('tech-a', [[29.77, -95.41], [29.9, -95.6]], [[29.9, -95.6], [29.8, -95.5]])];
    render(<ScheduleMap date="2026-11-02" />);
    expect(screen.getByText(/From the office/)).toBeTruthy();
  });
});

describe("a technician's day on the map", () => {
  const positions = new Map(PLACES.map((p) => [p.id, p]));

  it('is the saved route along the roads: the drive done and the drive ahead', () => {
    const driven: [number, number][] = [[29.77, -95.41], [29.85, -95.5], [29.9, -95.6]];
    const ahead: [number, number][] = [[29.9, -95.6], [29.8, -95.5]];
    const [ada] = dayRuns(DAY, positions, { allowed: true, byTechnician: new Map([['tech-a', route('tech-a', driven, ahead)]]) });
    expect(ada).toMatchObject({ name: 'Ada Lane', driven, ahead, straight: [] });
  });

  it('draws nothing while the route is still loading, rather than a straight line that jumps', () => {
    const [ada] = dayRuns(DAY, positions, { allowed: true, byTechnician: new Map() });
    expect(ada).toMatchObject({ driven: [], ahead: [], straight: [] });
  });

  it('joins the stops straight where no road route can be shown', () => {
    const failed = dayRuns(DAY, positions, { allowed: true, byTechnician: new Map([['tech-a', route('tech-a', [], [])]]) });
    expect(failed[0]!.straight).toEqual([
      [29.9, -95.6],
      [29.8, -95.5],
    ]);
    const notAllowed = dayRuns(DAY, positions, { allowed: false, byTechnician: new Map() });
    expect(notAllowed.map((run) => run.straight.length)).toEqual([2, 1]);
  });

  it('leaves out a stop with no place, and a technician with none at all', () => {
    const runs = dayRuns(
      [...DAY, { technicianId: 'tech-x', displayName: 'Nobody placed', stops: [{ buildingId: 'b-unknown' }] }],
      positions,
      { allowed: false, byTechnician: new Map() },
    );
    expect(runs.map((run) => [run.technicianId, run.stops.length])).toEqual([
      ['tech-a', 2],
      ['tech-z', 1],
    ]);
  });
});
