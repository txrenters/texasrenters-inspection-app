import { splitAtFirstStop } from '../src/planning/planning.controller';

/**
 * A day routed from home is drawn as one Google line and cut where it reaches
 * the first property, so the console can show the home leg apart: it is driven,
 * and not counted against the day's ninety minutes.
 */
describe('cutting a day’s road line at its first property', () => {
  const first = { latitude: 29.76, longitude: -95.37 };

  it('cuts at the vertex on the first property', () => {
    const path: [number, number][] = [
      [29.7, -95.37],
      [29.73, -95.37],
      [29.76, -95.37],
      [29.77, -95.37],
      [29.78, -95.37],
    ];

    const { homeGeometry, geometry } = splitAtFirstStop(path, first);

    expect(homeGeometry).toEqual(path.slice(0, 3));
    // Both halves share the first property, so the two lines meet.
    expect(geometry).toEqual(path.slice(2));
  });

  it('cuts at the nearest vertex when the line only passes close by', () => {
    const path: [number, number][] = [
      [29.7, -95.37],
      [29.758, -95.371],
      [29.79, -95.37],
    ];

    const { homeGeometry, geometry } = splitAtFirstStop(path, first);

    expect(homeGeometry).toHaveLength(2);
    expect(geometry[0]).toEqual([29.758, -95.371]);
  });

  /** Google snaps a stop to its road, so the line can pass it well beyond sixty metres -- and pass it twice. */
  it('cuts by the home leg’s measured length when the line passes the stop more than once', () => {
    // Home, out 6.7 km to beside the stop (about 200 m off, on its road), on
    // north, and back past the stop later in the day, closer this time.
    const path: [number, number][] = [
      [29.7, -95.37],
      [29.758, -95.3685],
      [29.79, -95.37],
      [29.7601, -95.37],
    ];
    const homeLeg = 6_470;

    const { homeGeometry, geometry } = splitAtFirstStop(path, first, homeLeg);

    expect(homeGeometry).toEqual(path.slice(0, 2));
    expect(geometry[0]).toEqual(path[1]);
  });

  it('takes the first pass, not a later one, when the day comes back by the first property', () => {
    const path: [number, number][] = [
      [29.7, -95.37],
      [29.76, -95.37],
      [29.8, -95.37],
      [29.76, -95.37],
    ];

    expect(splitAtFirstStop(path, first).homeGeometry).toHaveLength(2);
  });
});
