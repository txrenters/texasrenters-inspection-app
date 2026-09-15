import {
  draftProblems,
  EMPTY_SERVICES_DRAFT,
  readOtherSizes,
  reportFromDraft,
  servicesToReport,
  type ServicesDraft,
} from '../src/utils/services-report';

/**
 * The services checklist before a benefit-package visit can be submitted:
 * each booked service done or not, why not, and whether to book it again.
 */

const DETAILS =
  'Filter Change: (2 pcs) 20x25x1; 12x12x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)';

const ask = servicesToReport(DETAILS);
const draft = (overrides: Partial<ServicesDraft>): ServicesDraft => ({ ...EMPTY_SERVICES_DRAFT, ...overrides });

describe('what the technician is asked', () => {
  it('is the services the visit booked, with the filter sizes it listed', () => {
    expect(ask.services).toEqual([
      { key: 'filterChange', label: 'AC filter change' },
      { key: 'pestControl', label: 'Pest control' },
    ]);
    expect(ask.bookedSizes).toEqual(['20x25x1', '12x12x1']);
  });

  it('is nothing for a visit with no services, which then submits exactly as before', () => {
    const none = servicesToReport('Instruction Completion\n1. Conduct BTM Inspection');
    expect(none.services).toEqual([]);
    expect(draftProblems(none, EMPTY_SERVICES_DRAFT)).toEqual([]);
  });
});

describe('what stops the submit button', () => {
  it('asks for every service to be marked, first one first', () => {
    expect(draftProblems(ask, EMPTY_SERVICES_DRAFT)).toEqual([
      'Mark AC filter change done or not done.',
      'Mark pest control done or not done.',
    ]);
  });

  it('asks why a service was not done', () => {
    expect(
      draftProblems(
        ask,
        draft({
          services: {
            filterChange: { done: true, reason: '', reschedule: false },
            pestControl: { done: false, reason: '   ', reschedule: true },
          },
        }),
      ),
    ).toEqual(['Say why pest control was not done.']);
  });

  it('refuses a filter size that is not one', () => {
    expect(
      draftProblems(
        ask,
        draft({
          services: {
            filterChange: { done: true, reason: '', reschedule: false },
            pestControl: { done: true, reason: '', reschedule: false },
          },
          otherSizes: '16x25x1, the tall one',
        }),
      ),
    ).toEqual(['"the tall one" is not a filter size. Write it like 20x25x1.']);
  });
});

describe('the report sent with the submission', () => {
  it('carries each answer, the filters installed and the notes', () => {
    expect(
      reportFromDraft(
        ask,
        draft({
          services: {
            filterChange: { done: true, reason: 'ignored when done', reschedule: true },
            pestControl: { done: false, reason: ' Tenant asked not to spray, has a newborn. ', reschedule: true },
          },
          sizesNotInstalled: ['12x12x1'],
          otherSizes: '16 X 25 x 1',
          notes: ' Return air grille was blocked. ',
        }),
      ),
    ).toEqual({
      services: {
        filterChange: { done: true, reason: null, reschedule: false },
        pestControl: { done: false, reason: 'Tenant asked not to spray, has a newborn.', reschedule: true },
      },
      filtersInstalled: ['20x25x1', '16x25x1'],
      notes: 'Return air grille was blocked.',
    });
  });

  it('installs no filters when the filter change was not done', () => {
    const report = reportFromDraft(
      ask,
      draft({
        services: {
          filterChange: { done: false, reason: 'Wrong size in the van', reschedule: true },
          pestControl: { done: true, reason: '', reschedule: false },
        },
        otherSizes: '16x25x1',
      }),
    );
    expect(report.filtersInstalled).toEqual([]);
  });

  it('reads other sizes separated the ways people type them', () => {
    expect(readOtherSizes('16x25x1; 14 x 20 x 1\n12x12x1,')).toEqual({
      valid: ['16x25x1', '14x20x1', '12x12x1'],
      invalid: [],
    });
  });
});
