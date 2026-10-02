import { describe, expect, it } from 'vitest';

import { dayKey, dayLabels, planDayGroups, type DayStop } from './plan-day-groups';

/**
 * A quarter's days on the Groups tab, as the Group maker draws a template (the
 * office, 2026-10-01): each technician-day a group in its own colour, its stops
 * numbered in the order they are driven.
 */

const MOSES = { id: 'tech-moses', displayName: 'Moses Rodriguez' };
const KEVIN = { id: 'tech-kevin', displayName: 'Kevin Granados' };

let next = 0;
const stop = (scheduledOn: string | null, technician: DayStop['technician'], positionInDay: number | null, facts: Partial<DayStop> = {}): DayStop => {
  next += 1;
  return {
    id: `stop-${next}`,
    latitude: 29.76 + next / 1000,
    longitude: -95.37,
    scheduledOn,
    positionInDay,
    technician,
    zone: '2',
    address: `${next} Main St`,
    unit: null,
    city: 'Houston',
    postalCode: '77044',
    lease: `Lease ${next}`,
    hvacPlan: null,
    ...facts,
  };
};

describe('a quarter’s days as groups', () => {
  it('makes a group of each technician’s day, not of each date', () => {
    // With three people out, a date is three days -- and a template's group is one of them.
    const file = planDayGroups([stop('2026-10-06', MOSES, 1), stop('2026-10-06', KEVIN, 1), stop('2026-10-06', MOSES, 2)]);

    expect(file.groups.map((group) => group.key).sort()).toEqual(
      [dayKey('2026-10-06', KEVIN.id), dayKey('2026-10-06', MOSES.id)].sort(),
    );
  });

  it('numbers them in the order the quarter is worked: by date, then by whose day', () => {
    const file = planDayGroups([
      stop('2026-10-07', MOSES, 1),
      stop('2026-10-06', MOSES, 1),
      stop('2026-10-06', KEVIN, 1),
    ]);

    expect(file.groups.map((group) => [group.label, group.key])).toEqual([
      ['1', dayKey('2026-10-06', KEVIN.id)],
      ['2', dayKey('2026-10-06', MOSES.id)],
      ['3', dayKey('2026-10-07', MOSES.id)],
    ]);
  });

  it('puts day group 2 before day group 10 on a quarter sent out unassigned', () => {
    const file = planDayGroups([
      stop('2026-10-06', { id: 'g10', displayName: 'Day group 10' }, 1),
      stop('2026-10-06', { id: 'g2', displayName: 'Day group 2' }, 1),
    ]);

    expect(file.groups.map((group) => group.name)).toEqual(['Oct 6 · Day group 2', 'Oct 6 · Day group 10']);
  });

  it('numbers a day’s stops in the order they are driven', () => {
    const third = stop('2026-10-06', MOSES, 3);
    const first = stop('2026-10-06', MOSES, 1);
    const second = stop('2026-10-06', MOSES, 2);

    const [day] = planDayGroups([third, first, second]).groups;

    expect(day!.rows.map((row) => [row.address, row.stop])).toEqual([
      [first.address, 1],
      [second.address, 2],
      [third.address, 3],
    ]);
  });

  it('puts a stop the day has not ordered yet at the end', () => {
    const unordered = stop('2026-10-06', MOSES, null);
    const first = stop('2026-10-06', MOSES, 1);

    const [day] = planDayGroups([unordered, first]).groups;

    expect(day!.rows.map((row) => row.address)).toEqual([first.address, unordered.address]);
  });

  it('names a day by its date and whose day it is', () => {
    const [day] = planDayGroups([stop('2026-10-06', MOSES, 1)]).groups;

    expect(day!.name).toBe('Oct 6 · Moses Rodriguez');
    expect(day!.area).toBe('Houston');
  });

  it('gives neighbouring days colours of their own', () => {
    const file = planDayGroups([stop('2026-10-06', MOSES, 1), stop('2026-10-07', MOSES, 1), stop('2026-10-08', MOSES, 1)]);

    expect(new Set(file.groups.map((group) => group.color.fill)).size).toBe(3);
  });
});

describe('a visit with no day yet', () => {
  it('is drawn on its own, as a property in no group, and is not a day', () => {
    const file = planDayGroups([stop('2026-10-06', MOSES, 1), stop(null, null, null)]);

    expect(file.groups).toHaveLength(1);
    expect(file.ungrouped).toHaveLength(1);
    expect(file.ungrouped[0]!.stop).toBeNull();
  });
});

describe('a visit nobody has placed on the map', () => {
  it('is left off rather than drawn in the Atlantic', () => {
    const file = planDayGroups([
      stop('2026-10-06', MOSES, 1, { latitude: null, longitude: null }),
      stop('2026-10-06', MOSES, 2, { latitude: 0, longitude: 0 }),
      stop(null, null, null, { latitude: null, longitude: null }),
    ]);

    expect(file.groups).toHaveLength(0);
    expect(file.ungrouped).toHaveLength(0);
  });
});

describe('every pin on the map', () => {
  it('has an identity of its own, so a window opens on the right one', () => {
    const file = planDayGroups([stop('2026-10-06', MOSES, 1), stop('2026-10-06', KEVIN, 1), stop(null, null, null)]);
    const numbers = [...file.groups.flatMap((group) => group.rows), ...file.ungrouped].map((row) => row.rowNumber);

    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

/**
 * The office (2026-10-03): template Group 37, laid out on December 17, read as
 * "1" -- its place in the quarter -- and "let's not modify the groupings label,
 * it should stay the same as is".
 */
describe('a quarter built from a template', () => {
  const group = (position: number, color = '#7f77dd') => ({ position, color });
  const days = [
    { date: '2026-12-17T00:00:00.000Z', technicianId: MOSES.id, templateGroup: group(37) },
    { date: '2026-12-18T00:00:00.000Z', technicianId: MOSES.id, templateGroup: null },
    { date: '2026-12-21T00:00:00.000Z', technicianId: MOSES.id, templateGroup: group(4, '#1d9e75') },
    { date: '2026-12-22T00:00:00.000Z', technicianId: MOSES.id, templateGroup: null },
  ];

  it('labels each day with its template group’s number, and the days of none N1, N2 in order', () => {
    const labels = dayLabels(days);

    expect([...labels.entries()]).toEqual([
      [dayKey('2026-12-17', MOSES.id), { label: '37', color: '#7f77dd' }],
      [dayKey('2026-12-18', MOSES.id), { label: 'N1', color: null }],
      [dayKey('2026-12-21', MOSES.id), { label: '4', color: '#1d9e75' }],
      [dayKey('2026-12-22', MOSES.id), { label: 'N2', color: null }],
    ]);
  });

  it('labels nothing on a quarter with no template day, which keeps its own numbers', () => {
    expect(dayLabels(days.map((day) => ({ ...day, templateGroup: null })))).toEqual(new Map());
    expect(planDayGroups([stop('2026-10-06', MOSES, 1), stop('2026-10-07', MOSES, 1)], new Map()).groups.map((one) => one.label)).toEqual(['1', '2']);
  });

  it('draws the Groups tab’s days with those labels, in the template group’s colour', () => {
    const file = planDayGroups(
      [stop('2026-12-17', MOSES, 1), stop('2026-12-18', MOSES, 1), stop('2026-12-21', MOSES, 1), stop('2026-12-22', MOSES, 1)],
      dayLabels(days),
    );

    expect(file.groups.map((one) => one.label)).toEqual(['37', 'N1', '4', 'N2']);
    expect(file.groups[0]!.color.fill).toBe('#7f77dd');
    expect(file.groups[2]!.color.fill).toBe('#1d9e75');
  });

  it('gives a day the server has no row for yet the next N, never a template group’s number', () => {
    const file = planDayGroups([stop('2026-12-17', MOSES, 1), stop('2026-12-23', KEVIN, 1)], dayLabels(days));

    expect(file.groups.map((one) => one.label)).toEqual(['37', 'N3']);
  });
});
