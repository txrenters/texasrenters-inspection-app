import type { CoverageVisit, QuarterCoverage, QuarterCoverageProperty } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coverageCsv, daysLeftInQuarter, groupDetail, coverageCounts, nextStep } from './quarter-coverage';
import { QuarterCoverageView } from './quarter-coverage-view';

/**
 * The plan's Coverage tab (the office, 2026-11-20): every property in the
 * benefit package in one of four groups, with what to do next. Places invented.
 */

const csv = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock('@/lib/csv', async (importOriginal) => ({ ...(await importOriginal<object>()), downloadCsv: csv.downloadCsv }));

afterEach(() => csv.downloadCsv.mockReset());

const visit = (overrides: Partial<CoverageVisit> = {}): CoverageVisit => ({
  stopId: 'stop-1',
  inspectionId: 'insp-1',
  inspectionType: 'HVAC',
  scheduledOn: '2026-10-06',
  technician: 'Sam Tech',
  inspectionStatus: 'REVIEW_REQUIRED',
  stopStatus: 'PUBLISHED',
  bookedInJobber: true,
  fromJobber: false,
  previousLease: false,
  note: null,
  ...overrides,
});

const property = (buildingId: string, overrides: Partial<QuarterCoverageProperty> = {}): QuarterCoverageProperty => ({
  buildingId,
  address: `${buildingId} Oak St`,
  city: 'Houston',
  zone: '2',
  leases: 1,
  firstOnReport: '2026-09-04T13:00:00.000Z',
  group: 'COMPLETED',
  detail: 'IN_REVIEW',
  visit: visit({ stopId: `stop-${buildingId}`, inspectionId: `insp-${buildingId}` }),
  previousLeaseOpen: 0,
  missingLeases: 0,
  ...overrides,
});

const COVERAGE: QuarterCoverage = {
  planId: 'plan-1',
  quarterYear: 2026,
  quarterNumber: 4,
  today: '2026-11-20',
  properties: [
    property('1', { visit: visit({ previousLease: true, inspectionId: 'insp-1' }) }),
    // Visited for its old tenant; the new one has no visit.
    property('2', { detail: 'FINISHED', missingLeases: 1, visit: visit({ inspectionStatus: 'COMPLETED', inspectionId: 'insp-2' }) }),
    property('3', {
      group: 'SCHEDULED',
      detail: 'PAST_DUE',
      visit: visit({ inspectionId: 'insp-3', inspectionStatus: 'SCHEDULED', scheduledOn: '2026-11-16', bookedInJobber: false }),
    }),
    property('4', {
      group: 'SCHEDULED',
      detail: 'UPCOMING',
      leases: 3,
      visit: visit({ inspectionId: 'insp-4', inspectionStatus: 'SCHEDULED', scheduledOn: '2026-12-01' }),
      previousLeaseOpen: 1,
    }),
    property('5', {
      group: 'NOT_SCHEDULED',
      detail: 'NO_DAY',
      city: 'Conroe',
      zone: '1',
      visit: visit({ stopId: 'stop-5', inspectionId: null, inspectionStatus: null, stopStatus: 'UNSCHEDULED', scheduledOn: null, technician: null }),
    }),
    property('6', { group: 'NONE', detail: 'NOT_PLANNED', visit: null, firstOnReport: '2026-10-20T13:00:00.000Z', zone: '3', missingLeases: 1 }),
    property('7', {
      group: 'NONE',
      detail: 'EXCLUDED',
      visit: visit({ stopId: 'stop-7', inspectionId: null, inspectionStatus: null, stopStatus: 'EXCLUDED', scheduledOn: null, note: 'Its Jobber visit was deleted on 2026-11-12.' }),
    }),
  ],
  leftWithOpenVisit: [
    { buildingId: 'gone', address: '9 Gone Ct', city: 'Houston', visit: visit({ inspectionStatus: 'SCHEDULED', scheduledOn: '2026-11-25' }) },
  ],
};

const rows = () => screen.getAllByRole('row').slice(1);

describe('the quarter’s coverage tab', () => {
  it('counts the four groups, with their reasons, and how much of the package is visited', () => {
    render(<QuarterCoverageView coverage={COVERAGE} />);

    expect(screen.getByRole('status').textContent).toBe('7 properties are in the benefit package · 29% visited for Q4 2026 · 41 days left');
    expect(screen.getByText('1 in review · 1 finished')).toBeTruthy();
    expect(screen.getByText('1 past their day · 1 upcoming')).toBeTruthy();
    expect(screen.getByText('1 with no day')).toBeTruthy();
    expect(screen.getByText('1 not in the plan · 1 excluded')).toBeTruthy();
    expect(rows()).toHaveLength(7);
  });

  it('narrows the list to one group, and to what is searched', () => {
    render(<QuarterCoverageView coverage={COVERAGE} />);

    fireEvent.click(screen.getByRole('button', { name: /No Q4 2026 visit/ }));
    expect(rows().map((row) => within(row).getAllByRole('link')[0]!.textContent)).toEqual(['6 Oak St', '7 Oak St']);

    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search properties' }), { target: { value: 'conroe zone 1' } });
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText('On Jobber’s Unscheduled list: give it a day')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search properties' }), { target: { value: 'nowhere' } });
    expect(screen.getByText('No property here matches the search.')).toBeTruthy();
  });

  it('says what to do about each, and links to the visit, the plan or the Group maker', () => {
    const onOpenStop = vi.fn();
    render(<QuarterCoverageView coverage={COVERAGE} onOpenStop={onOpenStop} />);

    const [first, , late, units, noDay, joiner] = rows();
    expect(within(first!).getByText('Visited for the previous lease; waiting for the office’s review')).toBeTruthy();
    expect(within(late!).getByText('Never booked in Jobber, so the technician never saw it')).toBeTruthy();
    expect(within(late!).getByText('Past its day')).toBeTruthy();
    expect(within(late!).getByRole('link', { name: 'Open visit' }).getAttribute('href')).toBe('/inspections/insp-3');
    expect(within(units!).getByText('A visit for an ended lease still waiting in Jobber: cancel it · 3 enrolled leases')).toBeTruthy();

    fireEvent.click(within(noDay!).getByRole('button', { name: 'Open in the plan' }));
    expect(onOpenStop).toHaveBeenCalledWith('stop-5');
    expect(within(noDay!).queryByRole('link', { name: 'Open visit' })).toBeNull();

    expect(within(joiner!).getByText('On the tenant report since Oct 20, 2026, after the quarter was built')).toBeTruthy();
    // Nobody can add it here, so the Group maker is the way in.
    expect(within(joiner!).getByRole('link', { name: 'Find it a group' }).getAttribute('href')).toBe('/group-maker');
    expect(within(joiner!).getByRole('link', { name: '6 Oak St' }).getAttribute('href')).toBe('/properties/6');
    expect(screen.queryByRole('button', { name: 'Add to Q4 2026' })).toBeNull();
  });

  it('adds a property with no visit to the quarter, and says when one with a visit has a lease without', () => {
    const onAdd = vi.fn();
    const { rerender } = render(<QuarterCoverageView coverage={COVERAGE} onAdd={onAdd} />);

    const finished = rows()[1]!;
    expect(within(finished).getByText('Its current lease has no visit this quarter')).toBeTruthy();
    const joiner = rows()[5]!;
    expect(within(joiner).queryByRole('link', { name: 'Find it a group' })).toBeNull();
    fireEvent.click(within(joiner).getByRole('button', { name: 'Add to Q4 2026' }));
    expect(onAdd).toHaveBeenCalledWith('6');
    // Only where a lease has no stop: not the excluded one, whose lease has.
    expect(screen.getAllByRole('button', { name: 'Add to Q4 2026' })).toHaveLength(2);

    rerender(<QuarterCoverageView adding="6" coverage={COVERAGE} onAdd={onAdd} />);
    const busy = within(rows()[5]!).getByRole('button', { name: 'Adding…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns of a property that left the package with its visit still booked', () => {
    render(<QuarterCoverageView coverage={COVERAGE} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Left the package, still in Jobber (1)')).toBeTruthy();
    expect(within(alert).getByRole('link', { name: '9 Gone Ct' }).getAttribute('href')).toBe('/properties/gone');
    expect(alert.textContent).toContain('booked Wed, Nov 25');
  });

  it('exports the rows shown as a spreadsheet', () => {
    render(<QuarterCoverageView coverage={COVERAGE} />);

    fireEvent.click(screen.getByRole('button', { name: /Not scheduled/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(csv.downloadCsv).toHaveBeenCalledTimes(1);
    const [name, text] = csv.downloadCsv.mock.calls[0]!;
    expect(name).toBe('q4-2026-coverage-not-scheduled.csv');
    expect((text as string).split('\r\n')).toEqual([
      'Group,Visit,Address,City,Zone,Type,Day,Technician,Booked in Jobber,Next step,Notes',
      'Not scheduled,No day,5 Oak St,Conroe,Zone 1,HVAC,,,Yes,On Jobber’s Unscheduled list: give it a day,',
    ]);
  });

  it('says so when no property is in the package', () => {
    render(<QuarterCoverageView coverage={{ ...COVERAGE, properties: [], leftWithOpenVisit: [] }} />);

    expect(screen.getByText('No property in the package')).toBeTruthy();
  });
});

describe('the coverage words', () => {
  it('lists only the reasons a group has', () => {
    const { details } = coverageCounts(COVERAGE.properties.slice(0, 2));

    expect(groupDetail('COMPLETED', details)).toBe('1 in review · 1 finished');
    expect(groupDetail('NONE', details)).toBeUndefined();
  });

  it('names when a property not in the plan joined', () => {
    expect(nextStep(COVERAGE.properties[5]!)).toBe('On the tenant report since Oct 20, 2026, after the quarter was built');
    expect(nextStep({ ...COVERAGE.properties[5]!, firstOnReport: null })).toBe('Not in this quarter’s plan');
  });

  it('counts the days to the quarter’s end, and none after it', () => {
    expect(daysLeftInQuarter('2026-11-20', 2026, 4)).toBe(41);
    expect(daysLeftInQuarter('2026-12-31', 2026, 4)).toBe(0);
    expect(daysLeftInQuarter('2027-01-02', 2026, 4)).toBe(0);
  });

  it('keeps a formula-looking address from running in a spreadsheet', () => {
    const text = coverageCsv([{ ...COVERAGE.properties[5]!, address: '=HYPERLINK("x")' }], COVERAGE);

    expect(text.split('\r\n')[1]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
