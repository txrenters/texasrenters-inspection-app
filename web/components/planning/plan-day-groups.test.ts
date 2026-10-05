import { describe, expect, it } from 'vitest';

import { dayKey, dayLabels } from './plan-day-groups';

/**
 * A quarter's days, labelled as the Group maker numbers a template's groups
 * (the office, 2026-10-03: "let's not modify the groupings label").
 */

const MOSES = { id: 'tech-moses', displayName: 'Moses Rodriguez' };

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
  });
});
