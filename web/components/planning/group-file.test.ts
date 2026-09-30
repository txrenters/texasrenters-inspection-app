import { describe, expect, it } from 'vitest';

import {
  fanOffsets,
  groupColors,
  groupOutline,
  LONG_HOP_MINUTES,
  nearUngroupedGreen,
  readGroupFile,
  sortGroups,
  type FileGroup,
  type GroupFileRow,
} from './group-file';
import { groupSummary } from './group-file-legend';

/**
 * A groups file, read for the Groups map.
 *
 * Every row here is invented. The real file names tenants and their homes, and
 * this repository is public.
 */

const HEADER =
  'group,group_area,stop,address,city,zip,unit,lease,zone,hvac_plan,matched_to_property,latitude,longitude,group_span_miles,group_route_miles,geocode_source';

const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n') + '\r\n';

describe('reading a groups file', () => {
  it('reads it as it is: quoted commas, the file order of columns, and its own figures', () => {
    const file = readGroupFile(
      csv(
        '2,Katy / Fulshear,2,2 Elm St,Katy,77494,,"Doe, J.",2,On our AC Plan,t,29.78,-95.82,3.1,9.4,address',
        '2,Katy / Fulshear,1,1 Elm St,Katy,77494,,"Roe, R.",2,Not Completed,t,29.77,-95.81,3.1,9.4,address',
        '10,Houston,1,5 Oak St,Houston,77009,B,Poe,1,,t,29.80,-95.38,1.0,2.0,zip centroid',
      ),
    );

    expect(file.missing).toEqual([]);
    expect(file.placed).toBe(3);
    // Numerically, so 2 comes before 10.
    expect(file.groups.map((group) => group.key)).toEqual(['2', '10']);

    const katy = file.groups[0]!;
    expect(katy.area).toBe('Katy / Fulshear');
    expect(katy.spanMiles).toBe(3.1);
    expect(katy.routeMiles).toBe(9.4);
    // In the file's visiting order, whatever order the rows came in.
    expect(katy.rows.map((row) => row.address)).toEqual(['1 Elm St', '2 Elm St']);
    expect(katy.rows[1]).toMatchObject({ lease: 'Doe, J.', hvacPlan: 'On our AC Plan', stop: 2, rowNumber: 2 });

    const houston = file.groups[1]!.rows[0]!;
    expect(houston).toMatchObject({ unit: 'B', hvacPlan: null, approximate: true, geocodeSource: 'zip centroid' });
    expect(katy.rows[0]!.approximate).toBe(false);
  });

  it('finds the columns by name, whatever their order, and reads a spreadsheet’s byte-order mark', () => {
    const file = readGroupFile('﻿longitude,latitude,address,group\n-95.5,29.7,1 Main St,A\n');
    expect(file.groups[0]).toMatchObject({ key: 'A', area: null, spanMiles: null });
    expect(file.groups[0]!.rows[0]).toMatchObject({ latitude: 29.7, longitude: -95.5, stop: null, approximate: false });
  });

  it('names the columns it cannot draw without', () => {
    const file = readGroupFile('group,address,lat,lng\n1,1 Main St,29.7,-95.5\n');
    expect(file.missing).toEqual(['latitude', 'longitude']);
    expect(file.groups).toEqual([]);
  });

  /** A row that cannot be placed is named, so the file can be put right, rather than dropped quietly. */
  it('leaves off a row with no usable position, by its row number', () => {
    const file = readGroupFile(
      csv(
        '1,Houston,1,1 Main St,Houston,,,,1,,t,29.8,-95.4,1,1,address',
        '1,Houston,3,3 Main St,Houston,,,,1,,t,,,1,1,address',
        '1,Houston,4,4 Main St,Houston,,,,1,,t,0,0,1,1,address',
        '1,Houston,5,5 Main St,Houston,,,,1,,t,95.8,-95.4,1,1,address',
      ),
    );
    expect(file.placed).toBe(1);
    expect(file.skippedRows).toEqual([3, 4, 5]);
  });

  /** A manual grouping's export lists the properties it left out, with no group: they are on the map, grey. */
  it('keeps a row with a position and no group as ungrouped, not skipped', () => {
    const file = readGroupFile(
      csv('1,Houston,1,1 Main St,Houston,,,,1,,t,29.8,-95.4,1,1,address', ',,,2 Main St,Houston,,,,1,,t,29.81,-95.41,,,address'),
    );
    expect(file.skippedRows).toEqual([]);
    expect(file.ungrouped.map((row) => row.address)).toEqual(['2 Main St']);
    expect(file.groups).toHaveLength(1);
  });

  it('keeps every cell of a row as written, for an export to copy back', () => {
    const file = readGroupFile(csv('1,Katy,1,1 Elm St,Katy,77494,,"Doe, J.",2,On our AC Plan,t,29.780000,-95.8,1,1,zip centroid'));
    expect(file.groups[0]!.rows[0]!.cells).toMatchObject({
      lease: 'Doe, J.',
      matched_to_property: 't',
      latitude: '29.780000',
      geocode_source: 'zip centroid',
    });
    expect(file.header).toContain('matched_to_property');
  });

  /** An exported manual grouping comes back with the names and colours it was made with. */
  it('reads a group’s name and colour when the file gives them, and keeps its own colour otherwise', () => {
    const header = `${HEADER},group_name,group_color`;
    const file = readGroupFile(
      [
        header,
        '1,Katy,1,1 Elm St,Katy,,,,1,,t,29.7,-95.8,1,1,address,Katy run,#0067A5',
        '2,Spring,1,2 Oak St,Spring,,,,1,,t,30.0,-95.4,1,1,address,,',
      ].join('\r\n'),
    );
    expect(file.groups[0]).toMatchObject({ name: 'Katy run', label: '1', color: { fill: '#0067a5', ink: '#ffffff' } });
    expect(file.groups[1]!.name).toBeNull();
    expect(file.groups[1]!.color.fill).toMatch(/^#[0-9a-f]{6}$/);
  });
});

/** OKLab from `#rrggbb`, worked out here rather than borrowed, so the check is independent of the code checked. */
function oklab(hex: string): [number, number, number] {
  const [red, green, blue] = [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}
const difference = (one: string, other: string) => Math.hypot(...oklab(one).map((value, index) => value - oklab(other)[index]!));

const luminance = (hex: string) => {
  const [red, green, blue] = [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};

/**
 * The second file (2026-09-30): groups of 9 to 11 in the fastest driving order,
 * with the drive measured on real roads -- its size, its total drive and its
 * longest single hop.
 */
describe('a file of groups measured on the road', () => {
  const HEADER_WITH_DRIVE = `${HEADER},group_size,group_drive_minutes,longest_hop_minutes`;
  /** A stop in group `group`, laid out west to east unless placed elsewhere. */
  const stop = (group: number, order: number, figures: string, longitude = -95.5 + order * 0.01) =>
    `${group},Area ${group},${order},${order} Elm St,Katy,77494,,,1,,t,29.7,${longitude},2.0,${figures}`;
  const file = readGroupFile(
    [
      HEADER_WITH_DRIVE,
      // Group 1: ten stops, a 16-minute hop -- and the long step is 4 to 5.
      ...Array.from({ length: 10 }, (_, index) =>
        stop(1, index + 1, `12.5,address,10,72,16`, index < 4 ? -95.5 + index * 0.01 : -95.3 + index * 0.01),
      ),
      // Group 2: eleven stops, nothing longer than 14 minutes.
      ...Array.from({ length: 11 }, (_, index) => stop(2, index + 1, `9,address,11,39,14`)),
      // Group 3: nine stops and the longest drive of the three.
      ...Array.from({ length: 9 }, (_, index) => stop(3, index + 1, `30.5,address,9,85,15`)),
    ].join('\r\n'),
  );
  const [one, two, three] = file.groups as [FileGroup, FileGroup, FileGroup];

  it('reads each group’s size, drive and longest hop from the file, however many stops it has', () => {
    expect(file.groups.map((group) => [group.size, group.rows.length])).toEqual([
      [10, 10],
      [11, 11],
      [9, 9],
    ]);
    expect(one).toMatchObject({ driveMinutes: 72, longestHopMinutes: 16, routeMiles: 12.5 });
    // Stop numbers past nine, in the order given.
    expect(two.rows.map((row) => row.stop)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('marks a hop of 15 minutes or more, on the longest step between consecutive stops', () => {
    expect(LONG_HOP_MINUTES).toBe(15);
    // Index 3 is the step from stop 4 to stop 5.
    expect(one.longHop).toBe(3);
    expect(two.longHop).toBeNull();
    // Exactly 15 counts.
    expect(three.longHop).not.toBeNull();
  });

  it('says each group as "size · drive · route miles", and leaves out what the file does not give', () => {
    // The file's miles, shown in kilometres (the office, 2026-09-30): 12.5 mi is 20.1 km.
    expect(groupSummary(one)).toBe('10 properties · 72 min drive · 20.1 km');
    expect(groupSummary(three)).toBe('9 properties · 85 min drive · 49.1 km');
    expect(groupSummary({ size: 1, driveMinutes: null, routeMiles: null })).toBe('1 property');
  });

  it('sorts by group number, or by drive time with the longest first', () => {
    expect(sortGroups(file.groups, 'number').map((group) => group.key)).toEqual(['1', '2', '3']);
    expect(sortGroups(file.groups, 'drive').map((group) => group.key)).toEqual(['3', '1', '2']);
  });

  it('counts a group’s rows when an older file gives no size, and puts groups with no drive last', () => {
    const older = readGroupFile(csv('1,A,1,1 Main St,Houston,,,,1,,t,29.8,-95.4,1,1,address'));
    expect(older.groups[0]).toMatchObject({ size: 1, driveMinutes: null, longestHopMinutes: null, longHop: null });
    expect(sortGroups([...older.groups, one], 'drive').map((group) => group.driveMinutes)).toEqual([72, null]);
  });
});

describe('colouring the groups', () => {
  /**
   * Forty-four groups of nine in a 4 x 11 grid of touching squares, about 2km
   * across each: the shape of a quarter laid over the county.
   */
  const grid = Array.from({ length: 44 }, (_, index) => {
    const [row, column] = [Math.floor(index / 11), index % 11];
    return Array.from({ length: 9 }, (_, stop) => ({
      latitude: 29.6 + row * 0.02 + Math.floor(stop / 3) * 0.006,
      longitude: -95.8 + column * 0.023 + (stop % 3) * 0.007,
    }));
  });
  const colors = groupColors(grid);

  it('gives every group a colour of its own', () => {
    expect(new Set(colors.map((color) => color.fill)).size).toBe(44);
    for (const color of colors) expect(color.fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  /**
   * Forty-four colours cannot all be far apart. What matters is that the close
   * ones are never side by side: every pair of touching squares must differ
   * by far more than the closest two colours in the set do.
   */
  it('keeps neighbouring groups far apart in colour', () => {
    const touching: number[] = [];
    const all: number[] = [];
    for (let one = 0; one < 44; one += 1)
      for (let other = one + 1; other < 44; other += 1) {
        const value = difference(colors[one]!.fill, colors[other]!.fill);
        all.push(value);
        const [rowA, columnA, rowB, columnB] = [Math.floor(one / 11), one % 11, Math.floor(other / 11), other % 11];
        if (Math.abs(rowA - rowB) <= 1 && Math.abs(columnA - columnB) <= 1) touching.push(value);
      }
    // About six times the smallest difference anyone can see (~0.02).
    expect(Math.min(...touching)).toBeGreaterThan(0.12);
    expect(Math.min(...touching)).toBeGreaterThan(2 * Math.min(...all));
  });

  it('writes the stop number in whichever of white or near-black reads on the colour', () => {
    for (const { fill, ink } of colors) {
      const back = luminance(fill);
      const front = luminance(ink);
      expect((Math.max(back, front) + 0.05) / (Math.min(back, front) + 0.05)).toBeGreaterThanOrEqual(4);
    }
  });

  it('draws the same file in the same colours every time', () => {
    expect(groupColors(grid)).toEqual(colors);
  });

  /** Green is an ungrouped property's colour (2026-09-30): no group of a file may be given it. */
  it('never gives a group a colour that could pass for the ungrouped green', () => {
    for (const color of groupColors(grid)) expect(nearUngroupedGreen(color.fill)).toBe(false);
  });

  /** Nothing is built for 44: the second file has 39, and a later one may have more. */
  it('gives a distinct colour to any number of groups', () => {
    for (const count of [1, 7, 39, 60]) {
      const fills = groupColors(grid.slice(0, Math.min(count, 44)).concat(
        Array.from({ length: Math.max(0, count - 44) }, (_, index) => [{ latitude: 30.2 + index * 0.02, longitude: -95.1 }]),
      )).map((color) => color.fill);
      expect(new Set(fills).size).toBe(count);
    }
  });
});

/** Whether a point is strictly inside a closed ring, by ray casting. */
function insideRing(ring: [number, number][], latitude: number, longitude: number): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[previous]!;
    if (y1 > latitude !== y2 > latitude && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

describe('outlining a group', () => {
  /** The office (2026-09-30): the convex hull of the group's properties, nothing padded. */
  it('is the convex hull of its properties: the outermost are its corners, and it closes', () => {
    const corners = [
      { latitude: 29.76, longitude: -95.37 },
      { latitude: 29.76, longitude: -95.35 },
      { latitude: 29.78, longitude: -95.35 },
      { latitude: 29.78, longitude: -95.37 },
    ];
    const middle = { latitude: 29.77, longitude: -95.36 };
    const outline = groupOutline([...corners, middle]);

    expect(outline).toHaveLength(5);
    expect(outline[0]).toEqual(outline[4]);
    for (const corner of corners) expect(outline).toContainEqual([corner.longitude, corner.latitude]);
    expect(outline).not.toContainEqual([middle.longitude, middle.latitude]);
  });

  /**
   * The groups do not overlap, and the outline must not pretend they do. A
   * neighbour's property 200m past this group's edge sat inside the old outline,
   * padded 250m around every property.
   */
  it('does not reach a neighbouring group’s property just past its edge', () => {
    const group = [
      { latitude: 29.76, longitude: -95.37 },
      { latitude: 29.76, longitude: -95.35 },
      { latitude: 29.78, longitude: -95.35 },
      { latitude: 29.78, longitude: -95.37 },
    ];
    const neighbour = { latitude: 29.77, longitude: -95.348 };
    expect(insideRing(groupOutline(group), neighbour.latitude, neighbour.longitude)).toBe(false);
    expect(insideRing(groupOutline(group), 29.77, -95.36)).toBe(true);
  });

  /** Nothing to enclose: a row of properties is a line, three units at one address one point. */
  it('is a line for properties in a row, and a point for three units at one address', () => {
    const row = [-95.4, -95.39, -95.38].map((longitude) => ({ latitude: 29.7, longitude }));
    expect(groupOutline(row)).toEqual([
      [-95.4, 29.7],
      [-95.38, 29.7],
    ]);
    const spot = { latitude: 29.8, longitude: -95.38 };
    expect(groupOutline([spot, spot, spot])).toEqual([[-95.38, 29.8]]);
  });
});

describe('fanning out rows at one spot', () => {
  const row = (rowNumber: number, latitude: number, longitude: number) =>
    ({ rowNumber, latitude, longitude }) as GroupFileRow;

  it('gives each of three units at one address a pin of its own, clear of the others', () => {
    const offsets = fanOffsets([row(2, 29.81, -95.39), row(3, 29.81, -95.39), row(4, 29.81, -95.39), row(5, 29.7, -95.4)]);
    expect(offsets.has(5)).toBe(false);
    const pins = [2, 3, 4].map((rowNumber) => offsets.get(rowNumber)!);
    for (let one = 0; one < 3; one += 1)
      for (let other = one + 1; other < 3; other += 1)
        expect(Math.hypot(pins[one]![0] - pins[other]![0], pins[one]![1] - pins[other]![1])).toBeGreaterThanOrEqual(22);
  });
});
