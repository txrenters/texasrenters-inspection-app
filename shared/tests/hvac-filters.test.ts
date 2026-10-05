import { describe, expect, it } from 'vitest';

import {
  bookedFilters,
  filterLabel,
  filtersNotChanged,
  filtersRemoved,
  HVAC_WALKED_SECTIONS,
  installedFilters,
  jobServices,
  parseVisitDetails,
  servicesReportProblems,
  type VisitFilterOutcome,
  type VisitServicesReport,
} from '../src/index.js';

/**
 * An HVAC job's filters are scored on its AC filter change, not in a Filters
 * section of the inspection (Moses, 2026-10-01): "Keep the AC filter change and
 * remove it from the HVAC inspection part of it. Include the questions on the AC
 * filter change part of it." And the filters can be removed or resized: "make
 * it where I can adjust the amount of filters, remove or change as necessary".
 */

const BOOKED = 'Filter Change: 20x25x1 hallway; 12x12x1 downstairs + HVAC Inspection';
const UNBOOKED = 'HVAC Inspection';

const outcome = (over: Partial<VisitFilterOutcome> = {}): VisitFilterOutcome => ({
  size: '20x25x1',
  location: 'hallway',
  slot: 1,
  changed: true,
  reason: null,
  photoId: null,
  photoKey: 'snapshot-stack',
  booked: true,
  ...over,
});
const scored = { isClean: true, isUndamaged: true, isWorking: false };

const problemsFor = (details: string, filters: VisitFilterOutcome[], inspectionType = 'HVAC') => {
  const parsed = parseVisitDetails(details);
  const report: Pick<VisitServicesReport, 'services' | 'filters'> = {
    services: { filterChange: { done: true, reason: null, reschedule: false } },
    filters,
  };
  return servicesReportProblems(jobServices(parsed, inspectionType), report, bookedFilters(parsed), {
    assessFilters: inspectionType === 'HVAC',
  });
};

describe('the HVAC inspection without its Filters section', () => {
  it('walks Attic, A/C unit and Thermostat', () => {
    expect([...HVAC_WALKED_SECTIONS]).toEqual(['Attic', 'A/C unit', 'Thermostat']);
  });
});

describe('the services an HVAC job answers for', () => {
  it('always include the AC filter change, booked or not', () => {
    expect(jobServices(parseVisitDetails(UNBOOKED), 'HVAC')).toEqual(['filterChange']);
    expect(jobServices(parseVisitDetails(BOOKED), 'HVAC')).toEqual(['filterChange']);
  });

  it('are unchanged on an occupied job', () => {
    expect(jobServices(parseVisitDetails('Pest Control + Occupied Inspection'), 'OCCUPIED')).toEqual(['pestControl']);
  });
});

describe('what an HVAC job asks of its filters', () => {
  it('asks each listed filter for its score as well as its photograph', () => {
    const problems = problemsFor(BOOKED, [
      outcome(),
      outcome({ size: '12x12x1', location: 'downstairs', ...scored }),
    ]);
    expect(problems).toEqual(['Score Clean, Undamaged and Working for the 20x25x1 · hallway filter, or say why not.']);
  });

  it('takes a comment where a filter could not be scored', () => {
    expect(
      problemsFor(BOOKED, [
        outcome({ comment: 'Could not reach' }),
        outcome({ size: '12x12x1', location: 'downstairs', ...scored }),
      ]),
    ).toEqual([]);
  });

  it('asks nothing more of a listed filter that is not at the property', () => {
    expect(
      problemsFor(BOOKED, [
        outcome({ ...scored }),
        outcome({ size: '12x12x1', location: 'downstairs', changed: false, photoKey: null, removed: true }),
      ]),
    ).toEqual([]);
  });

  it('asks only for scores when the visit booked no filter change', () => {
    const found = outcome({ booked: false, changed: false, photoKey: null, location: null });
    expect(problemsFor(UNBOOKED, [found])).toEqual([
      'Score Clean, Undamaged and Working for the 20x25x1 filter, or say why not.',
    ]);
    expect(problemsFor(UNBOOKED, [{ ...found, ...scored }])).toEqual([]);
  });

  it('asks an occupied job nothing about scores, as before', () => {
    expect(
      problemsFor(
        'Filter Change: 20x25x1 hallway + Occupied Inspection',
        [outcome()],
        'OCCUPIED',
      ),
    ).toEqual([]);
  });
});

describe('a corrected filter, as the office reads it', () => {
  const report: Pick<VisitServicesReport, 'filters' | 'filtersInstalled'> = {
    filtersInstalled: [],
    filters: [
      outcome({ actualSize: '20x20x1' }),
      outcome({ size: '12x12x1', location: 'downstairs', changed: false, photoKey: null, removed: true }),
      outcome({ size: '16x25x1', location: 'attic', changed: false, photoKey: null, reason: 'Wrong size brought' }),
    ],
  };

  it('installs the size really there, never one removed', () => {
    expect(installedFilters(report)).toEqual(['20x20x1']);
  });

  it('names a resized filter by its real size', () => {
    expect(filterLabel(report.filters![0]!)).toBe('20x20x1 · hallway');
  });

  it('keeps a removed filter out of the not-changed list, and lists it apart', () => {
    expect(filtersNotChanged(report).map((filter) => filter.size)).toEqual(['16x25x1']);
    expect(filtersRemoved(report).map((filter) => filter.size)).toEqual(['12x12x1']);
  });
});
