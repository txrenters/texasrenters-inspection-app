import { describe, expect, it } from 'vitest';

import {
  FILTER_SIZE_PATTERN,
  normalizeFilterSize,
  parseVisitDetails,
  reportableServices,
  servicesReportProblems,
  servicesToReschedule,
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
