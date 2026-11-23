import { levelFor, readScopeSheet, skillKeyFor } from '../src/work-orders/technician-scope-sheet';
import { TECHNICIAN_SCOPE_SHEET } from '../src/work-orders/technician-scope-sheet.data';

/** The Technicians' Scope of Work sheet, as the office sent it. */

describe('levelFor', () => {
  it.each([
    ['Y', '', 'FULL'],
    ['Y', 'CAN REPLACE WATER HEATER', 'FULL'],
    ['Y', 'CAN COMPLETE MAKE-READY JOBS', 'FULL'],
    ['Y', 'MINOR REPAIRS ONLY', 'LIMITED'],
    ['Y', 'IF LAWN MOWER IS PROVIDED', 'LIMITED'],
    ['Y', 'NEEDS IMPROVEMENT', 'NEEDS_IMPROVEMENT'],
    ['N', '', null],
    ['', 'N', null],
  ])('%s with "%s" is %s', (mark, remark, level) => {
    expect(levelFor(mark, remark)).toBe(level);
  });
});

describe('readScopeSheet', () => {
  const { skills, grants } = readScopeSheet(TECHNICIAN_SCOPE_SHEET);
  const grant = (technician: string, job: string) =>
    grants.find((g) => g.technician === technician && g.skillKey === skillKeyFor(job));

  it('makes one skill of a job listed twice', () => {
    expect(skills.filter((skill) => skill.key === 'interior-paint')).toHaveLength(1);
    expect(skills.filter((skill) => skill.key === 'turnover')).toHaveLength(1);
    expect(new Set(skills.map((skill) => skill.key)).size).toBe(skills.length);
  });

  it('reads the marks the office gave', () => {
    expect(grant('Kevin Granados', 'Water heater')).toMatchObject({ level: 'LIMITED', note: 'MINOR REPAIRS ONLY' });
    expect(grant('Thomas Allen Kivi', 'Water heater')).toMatchObject({ level: 'FULL', note: 'CAN REPLACE WATER HEATER' });
    expect(grant('Kevin Granados', 'Paint')).toMatchObject({ level: 'NEEDS_IMPROVEMENT' });
    expect(grant('Amy Wilson', 'Plumbing')).toBeUndefined();
    expect(grant('Thomas Allen Kivi', 'Thermostat')).toBeUndefined();
  });
});
