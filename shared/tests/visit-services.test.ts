import { describe, expect, it } from 'vitest';

import {
  FILTER_SIZE_PATTERN,
  bookedFilters,
  filterKey,
  filterLabel,
  filtersNotChanged,
  installedFilters,
  installedFiltersSummary,
  normalizeFilterSize,
  parseVisitDetails,
  reportableServices,
  servicesReportProblems,
  servicesToReschedule,
  type VisitFilterOutcome,
  type VisitServicesReport,
} from '../src/index.js';

/**
 * The services a technician reports before submitting a benefit-package visit.
 *
 * The phone's submit button and the API both run `servicesReportProblems`, so a
 * technician is never told "ready" by one and "incomplete" by the other.
 */

const booked = reportableServices(
  parseVisitDetails('Filter Change: 20x25x1 + Pest Control + Occupied Inspection (Basic Plan)'),
);

const report = (services: VisitServicesReport['services']): VisitServicesReport => ({
  services,
  filtersInstalled: [],
  notes: null,
});

describe('which services a technician reports on', () => {
  it('is what the visit booked, in the office order, never the inspection itself', () => {
    expect(booked).toEqual(['filterChange', 'pestControl']);
    expect(
      reportableServices(parseVisitDetails('Filter Change: 12x24x1 + Pest Control + Flea Treatment')),
    ).toEqual(['filterChange', 'pestControl', 'fleaTreatment']);
  });

  it('is nothing for a visit with no services line', () => {
    expect(reportableServices(parseVisitDetails('Instruction Completion\n1. Conduct BTM Inspection'))).toEqual([]);
  });
});

describe('what still stops a submission', () => {
  it('asks for every booked service to be marked', () => {
    expect(servicesReportProblems(booked, report({ filterChange: { done: true, reason: null, reschedule: false } }))).toEqual([
      'Mark pest control done or not done.',
    ]);
    expect(servicesReportProblems(booked, null)).toHaveLength(2);
  });

  it('asks why a service was not done', () => {
    expect(
      servicesReportProblems(
        booked,
        report({
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: false, reason: '  ', reschedule: true },
        }),
      ),
    ).toEqual(['Say why pest control was not done.']);
  });

  it('is nothing once each service is done, or not done with a reason', () => {
    expect(
      servicesReportProblems(
        booked,
        report({
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: false, reason: 'Tenant asked us not to spray, has a newborn', reschedule: true },
        }),
      ),
    ).toEqual([]);
  });
});

describe('the rest of the report', () => {
  it('lists the services to book again, and only ones not done', () => {
    expect(
      servicesToReschedule(
        report({
          filterChange: { done: true, reason: null, reschedule: true },
          pestControl: { done: false, reason: 'Locked gate', reschedule: true },
          fleaTreatment: { done: false, reason: 'No pets any more', reschedule: false },
        }),
      ),
    ).toEqual(['pestControl']);
    expect(servicesToReschedule(null)).toEqual([]);
  });

  it('reads filter sizes the way technicians type them, and writes them one way', () => {
    for (const size of ['20x25x1', '20 X 25 x 1', '12 x 36', '20x25x4.5']) expect(FILTER_SIZE_PATTERN.test(size)).toBe(true);
    for (const size of ['20x', 'big one', '20-25-1']) expect(FILTER_SIZE_PATTERN.test(size)).toBe(false);
    expect(normalizeFilterSize(' 20 X 25 x 1 ')).toBe('20x25x1');
  });
});

/**
 * A photograph of every register, showing the size printed on the filter
 * (Moses, via the office, 2026-09-18). One photograph of "the filter change"
 * says nothing about the second register in a house with two.
 */

const TWO_REGISTERS = parseVisitDetails(
  'Filter Change: 20x25x1 (2 pcs) upstairs hallway; 12x12x1 downstairs + Pest Control + Occupied Inspection',
);

const changed = (over: Partial<VisitFilterOutcome>): VisitFilterOutcome => ({
  size: '20x25x1',
  location: 'upstairs hallway',
  slot: 1,
  changed: true,
  reason: null,
  photoId: 'photo-1',
  booked: true,
  ...over,
});

const withFilters = (filters: VisitFilterOutcome[]): VisitServicesReport => ({
  services: {
    filterChange: { done: true, reason: null, reschedule: false },
    pestControl: { done: true, reason: null, reschedule: false },
  },
  filters,
  filtersInstalled: [],
  notes: null,
});

describe('the filter registers a visit books', () => {
  it('expands a quantity into one register each, normalising the size', () => {
    expect(bookedFilters(parseVisitDetails('Filter Change: 20 X 25 x 1 (2 pcs) attic'))).toEqual([
      { size: '20x25x1', location: 'attic', slot: 1, media: false },
      { size: '20x25x1', location: 'attic', slot: 2, media: false },
    ]);
  });

  it('reads every size the coordinator listed', () => {
    expect(bookedFilters(TWO_REGISTERS).map((filter) => `${filter.size}#${filter.slot}`)).toEqual([
      '20x25x1#1',
      '20x25x1#2',
      '12x12x1#1',
    ]);
  });

  // The Details the console writes list a size once per register. Each entry
  // used to start at slot 1, so the two 16x25x1 were one register: the phone
  // asked once and the Jobber note -- the invoice -- listed one (2026-10-06).
  it('numbers a size listed twice as two registers, not one', () => {
    const booked = bookedFilters(
      parseVisitDetails('Filter Change: 12x24x1;16x25x1;16x25x1 + Pest Control + HVAC Inspection'),
    );
    expect(booked.map((filter) => `${filter.size}#${filter.slot}`)).toEqual([
      '12x24x1#1',
      '16x25x1#1',
      '16x25x1#2',
    ]);
    // The second is what a phone built before this could not ask about.
    expect(booked.map((filter) => Boolean(filter.listedAgain))).toEqual([false, false, true]);
    expect(new Set(booked.map((filter) => filterKey(filter))).size).toBe(3);
  });

  it('refuses to ask for twenty photographs because of a mistyped quantity', () => {
    expect(bookedFilters(parseVisitDetails('Filter Change: 20x25x1 (40 pcs)')).length).toBe(12);
  });

  it('names a register the way the office reads it', () => {
    const [first] = bookedFilters(TWO_REGISTERS);
    expect(filterLabel(first!, 2)).toBe('20x25x1 · upstairs hallway (1 of 2)');
    expect(filterLabel(first!, 1)).toBe('20x25x1 · upstairs hallway');
  });
});

describe('what stops a submission once every register is asked about', () => {
  const booked3 = bookedFilters(TWO_REGISTERS);
  const services = reportableServices(TWO_REGISTERS);

  it('asks for an answer for each register the visit listed', () => {
    const problems = servicesReportProblems(services, withFilters([changed({})]), booked3);

    expect(problems).toEqual([
      'Answer for the 20x25x1 · upstairs hallway (2 of 2) filter.',
      'Answer for the 12x12x1 · downstairs filter.',
    ]);
  });

  it('asks for the photograph of one marked changed', () => {
    const filters = [
      changed({ photoId: null }),
      changed({ slot: 2 }),
      changed({ size: '12x12x1', location: 'downstairs' }),
    ];

    expect(servicesReportProblems(services, withFilters(filters), booked3)).toEqual([
      'Photograph the 20x25x1 · upstairs hallway (1 of 2) filter.',
    ]);
  });

  it('asks why one was not changed, and takes a reason instead of a photograph', () => {
    const notChanged = changed({ changed: false, photoId: null, reason: '' });
    expect(servicesReportProblems(services, withFilters([notChanged, changed({ slot: 2 }), changed({ size: '12x12x1', location: 'downstairs' })]), booked3)).toEqual([
      'Say why the 20x25x1 · upstairs hallway (1 of 2) filter was not changed.',
    ]);

    const answered = { ...notChanged, reason: 'Register painted over' };
    expect(servicesReportProblems(services, withFilters([answered, changed({ slot: 2 }), changed({ size: '12x12x1', location: 'downstairs' })]), booked3)).toEqual([]);
  });

  it('asks nothing about registers when the filter change itself did not happen', () => {
    // Already answered, with a reason, at the level the office asked about.
    const report: VisitServicesReport = {
      services: {
        filterChange: { done: false, reason: 'Nobody home', reschedule: true },
        pestControl: { done: true, reason: null, reschedule: false },
      },
      filtersInstalled: [],
      notes: null,
    };

    expect(servicesReportProblems(services, report, booked3)).toEqual([]);
  });

  it('leaves a report made before photographs were asked for alone', () => {
    // No booked list passed, which is how the older path calls it.
    expect(
      servicesReportProblems(services, {
        services: {
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: true, reason: null, reschedule: false },
        },
      }),
    ).toEqual([]);
  });

  it('asks the phone about both of a size listed twice, and lets an older phone’s one answer through on the server', () => {
    const details = parseVisitDetails('Filter Change: 12x24x1;16x25x1;16x25x1');
    const listed = bookedFilters(details);
    const answers = [
      changed({ size: '12x24x1', location: null }),
      // An older phone: one answer, slot 1, for both 16x25x1 rows.
      changed({ size: '16x25x1', location: null }),
    ];
    const filterOnly = reportableServices(details);

    expect(servicesReportProblems(filterOnly, withFilters(answers), listed)).toEqual([
      'Answer for the 16x25x1 (2 of 2) filter.',
    ]);
    expect(
      servicesReportProblems(filterOnly, withFilters(answers), listed, { acceptOlderPhones: true }),
    ).toEqual([]);
    // Every other register is still asked about on the server.
    expect(
      servicesReportProblems(filterOnly, withFilters(answers.slice(1)), listed, { acceptOlderPhones: true }),
    ).toEqual(['Answer for the 12x24x1 filter.']);
  });

  it('still wants a photograph of a register the technician found on site', () => {
    const found = changed({ size: '16x20x1', location: null, booked: false, photoId: null });

    expect(
      servicesReportProblems(services, withFilters([changed({}), changed({ slot: 2 }), changed({ size: '12x12x1', location: 'downstairs' }), found]), booked3),
    ).toEqual(['Photograph the 16x20x1 filter you found.']);
  });
});

describe('what the office reads back', () => {
  // The invoice is made from the note: a size installed twice is two filters.
  it('lists every filter installed, a size as often as it went in, and counts them', () => {
    const report = withFilters([
      changed({}),
      changed({ slot: 2 }),
      changed({ size: '12x12x1', location: 'downstairs', changed: false, reason: 'Painted over', photoId: null }),
    ]);

    expect(installedFilters(report)).toEqual(['20x25x1', '20x25x1']);
    expect(installedFiltersSummary(report)).toBe('2 filters: 2 × 20x25x1');
    expect(filtersNotChanged(report).map((filter) => filter.reason)).toEqual(['Painted over']);
  });

  it('counts each size in the order it was first installed', () => {
    const report = withFilters([
      changed({ size: '12x24x1', location: null }),
      changed({ size: '16x25x1', location: null }),
      changed({ size: '16x25x1', location: null, slot: 2 }),
    ]);
    expect(installedFiltersSummary(report)).toBe('3 filters: 1 × 12x24x1, 2 × 16x25x1');
  });

  it('falls back to the old list when a report carries no registers, keeping its repeats', () => {
    expect(installedFilters({ filtersInstalled: ['20x25x1', '20x25x1', '12x12x1'] })).toEqual([
      '20x25x1',
      '20x25x1',
      '12x12x1',
    ]);
    expect(installedFiltersSummary({ filtersInstalled: ['12x12x1'] })).toBe('1 filter: 1 × 12x12x1');
    expect(installedFilters(null)).toEqual([]);
    expect(installedFiltersSummary(null)).toBeNull();
  });
});
