import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanDay, PlanRotation, PlanSettings } from '@/lib/planning-queries';

import { PlanCalendar, quarterMonths } from './plan-calendar';

const Q4 = { year: 2026, quarter: 4 as const };

const SETTINGS: PlanSettings = {
  occupiedVisitMinutes: 20,
  hvacVisitMinutes: 20,
  maxOnSiteMinutes: 360,
  maxDriveMinutes: 90,
  minStopsPerDay: 9,
  maxStopsPerDay: 12,
  // The day after Thanksgiving, closed by the office on top of the US holidays.
  holidays: ['2026-11-27'],
};

const ROTATION: PlanRotation = {
  crew: [
    { technicianId: 'moses', displayName: 'Moses Rodriguez', hasHome: true },
    { technicianId: 'kevin', displayName: 'Kevin Granados', hasHome: true },
    { technicianId: 'emanuel', displayName: 'Emanuel Hall', hasHome: true },
  ],
  zones: ['1', '2', '3', '4'],
  outOfReach: ['5'],
  weeks: [],
};

const day = (id: string, date: string, technicianId: string, displayName: string, stopCount: number, zone: string) =>
  ({
    id,
    date: `${date}T00:00:00.000Z`,
    technicianId,
    technician: { id: technicianId, displayName },
    stopCount,
    onSiteMinutes: stopCount * 20,
    hvacStopCount: 2,
    totalDriveSeconds: null,
    totalDriveMeters: null,
    homeDriveSeconds: null,
    homeDriveMeters: null,
    originKind: 'HOME',
    durationSource: null,
    stops: Array.from({ length: stopCount }, (_, index) => ({
      id: `${id}-stop-${index + 1}`,
      sequence: index + 1,
      positionInDay: index + 1,
      inspectionType: 'OCCUPIED',
      onSiteMinutes: 20,
      driveSecondsForecast: null,
      zone,
      status: 'PLANNED',
      address: null,
      city: null,
      latitude: null,
      longitude: null,
    })),
  }) as unknown as PlanDay;

const DAYS = [
  day('kevin-oct-1', '2026-10-01', 'kevin', 'Kevin Granados', 9, '2'),
  day('moses-oct-1', '2026-10-01', 'moses', 'Moses Rodriguez', 10, '1'),
  day('emanuel-oct-2', '2026-10-02', 'emanuel', 'Emanuel Hall', 12, '3'),
  day('moses-oct-6', '2026-10-06', 'moses', 'Moses Rodriguez', 7, '2'),
];

describe('the quarter as months of weekdays', () => {
  it('lays each month out Monday to Friday, blank where a week reaches outside it', () => {
    const months = quarterMonths(Q4);

    expect(months.map((month) => month.label)).toEqual(['October 2026', 'November 2026', 'December 2026']);
    // Thursday 1 October.
    expect(months[0]!.weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02']);
    // 1 November is a Sunday, so November's first week is the week after.
    expect(months[1]!.weeks[0]).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    expect(months[2]!.weeks.at(-1)).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', null]);
  });
});

describe('the benefit-package calendar', () => {
  it('puts each technician-day on its date in the crew’s order, and opens the one clicked', () => {
    const onSelect = vi.fn();
    render(<PlanCalendar days={DAYS} onSelect={onSelect} quarter={Q4} rotation={ROTATION} settings={SETTINGS} />);

    const october = screen.getByRole('region', { name: 'October 2026' });
    const kevin = within(october).getByRole('button', {
      name: 'Thursday, October 1: Kevin Granados, 9 visits (2 HVAC), zone 2, 3 hr inspecting',
    });
    const moses = within(october).getByRole('button', { name: /^Thursday, October 1: Moses Rodriguez, 10 visits/ });
    // Moses is first on the crew, so first on the day.
    expect(moses.compareDocumentPosition(kevin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(kevin);
    expect(onSelect).toHaveBeenCalledWith('kevin-oct-1');
  });

  it('marks US holidays, days the office closed, and the Mondays kept free', () => {
    render(<PlanCalendar days={DAYS} onSelect={vi.fn()} quarter={Q4} rotation={ROTATION} settings={SETTINGS} />);

    const october = screen.getByRole('region', { name: 'October 2026' });
    // Oct 12 is a US holiday; Oct 5, 19 and 26 are kept for rescheduled visits.
    expect(within(october).getAllByText('US holiday')).toHaveLength(1);
    expect(within(october).getAllByText('Kept free')).toHaveLength(3);
    const november = screen.getByRole('region', { name: 'November 2026' });
    expect(within(november).getAllByText('US holiday')).toHaveLength(2);
    expect(within(november).getByText('Closed')).toBeTruthy();
  });

  it('says which days are outside the office’s rules', () => {
    render(<PlanCalendar days={DAYS} onSelect={vi.fn()} quarter={Q4} rotation={ROTATION} settings={SETTINGS} />);

    expect(screen.getByRole('button', { name: /^Tuesday, October 6: Moses Rodriguez, 7 visits.*, outside the rules$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Friday, October 2: Emanuel Hall, 12 visits.*inspecting$/ })).toBeTruthy();
  });

  it('marks a day built around a move-out', () => {
    const anchored = {
      ...day('moses-oct-14', '2026-10-14', 'moses', 'Moses Rodriguez', 10, '3'),
      anchors: [{ id: 'anchor-1', inspectionId: 'move-out-1' }],
    } as unknown as PlanDay;
    render(<PlanCalendar days={[anchored]} onSelect={vi.fn()} quarter={Q4} rotation={ROTATION} settings={SETTINGS} />);

    expect(screen.getByRole('button', { name: /^Wednesday, October 14: Moses Rodriguez, 10 visits.*, built around a move-out, / })).toBeTruthy();
  });

  it('keys each technician’s colour and totals', () => {
    render(<PlanCalendar days={DAYS} onSelect={vi.fn()} quarter={Q4} rotation={ROTATION} settings={SETTINGS} />);

    expect(screen.getByText('2 days · 17 visits')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'October 2026' }).textContent).toContain('4 technician-days · 38 visits');
  });
});
