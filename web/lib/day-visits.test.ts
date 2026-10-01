import type { AssignedStop, TechnicianAssignments } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { allSubmitted, visitsByProperty } from './day-visits';

const stop = (inspectionId: string, buildingId: string | null, status: string): AssignedStop => ({
  inspectionId,
  buildingId,
  propertyName: 'A property',
  inspectionType: 'MOVE_OUT',
  status,
  finishedAt: status === 'TECHNICIAN_SUBMITTED' ? '2026-10-02T19:14:00.000Z' : null,
});

const day: TechnicianAssignments[] = [
  {
    technicianId: 'tech-1',
    displayName: 'First Technician',
    stops: [
      stop('inspection-1', 'building-a', 'TECHNICIAN_SUBMITTED'),
      stop('inspection-2', 'building-b', 'SCHEDULED'),
      stop('inspection-3', null, 'TECHNICIAN_SUBMITTED'),
    ],
  },
  {
    technicianId: 'tech-2',
    displayName: 'Second Technician',
    stops: [stop('inspection-4', 'building-b', 'COMPLETED')],
  },
];

describe('visitsByProperty', () => {
  it('lists every technician’s inspections under the property they are at', () => {
    const visits = visitsByProperty(day);
    expect(visits.get('building-a')).toEqual([
      {
        inspectionId: 'inspection-1',
        inspectionType: 'MOVE_OUT',
        status: 'TECHNICIAN_SUBMITTED',
        finished: true,
        finishedAt: '2026-10-02T19:14:00.000Z',
        technicianName: 'First Technician',
      },
    ]);
    expect(visits.get('building-b')?.map((visit) => [visit.inspectionId, visit.technicianName, visit.finished])).toEqual([
      ['inspection-2', 'First Technician', false],
      ['inspection-4', 'Second Technician', true],
    ]);
  });

  it('leaves out a stop with no building, which no disc can show', () => {
    expect([...visitsByProperty(day).keys()].sort()).toEqual(['building-a', 'building-b']);
  });

  it('is empty before the day has loaded', () => {
    expect(visitsByProperty(undefined).size).toBe(0);
  });
});

describe('allSubmitted', () => {
  const visits = visitsByProperty(day);

  it('ticks a property whose every inspection that day is in', () => {
    expect(allSubmitted(visits.get('building-a'))).toBe(true);
  });

  it('does not tick one with an inspection still to do, or one with none', () => {
    expect(allSubmitted(visits.get('building-b'))).toBe(false);
    expect(allSubmitted(undefined)).toBe(false);
    expect(allSubmitted([])).toBe(false);
  });
});
