import type { AdminInspection, VisitServicesReport } from '@texasrenters/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { JobNotes } from './job-notes';

/** The job's Notes section. Everything here is invented. */

const report: VisitServicesReport = {
  services: {
    filterChange: { done: true, reason: null, reschedule: false },
    pestControl: { done: false, reason: 'Tenant has a newborn.', reschedule: false },
  },
  filters: [
    {
      size: '20x25x1',
      location: 'Hallway',
      slot: 1,
      changed: false,
      reason: 'Wrong size on the truck',
      photoId: null,
      booked: true,
    },
  ],
  filtersInstalled: [],
  notes: 'Return air grille was blocked.',
};

function show(over: Partial<AdminInspection> = {}, action?: React.ReactNode) {
  render(<JobNotes action={action} inspection={{ internalNotes: null, ...over } as AdminInspection} />);
}

const group = (name: string) => screen.getByRole('region', { name });

describe('the Notes section', () => {
  it('says so when nobody has written anything, and leaves out a report group with nothing in it', () => {
    show();
    expect(within(group('From the technician')).getByText('No notes from the technician.')).toBeInTheDocument();
    expect(within(group('From the office')).getByText('No office notes yet.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Printed on the report' })).toBeNull();
  });

  it('gathers what the technician wrote, each under where it was written', () => {
    show({
      servicesReport: report,
      areaNotes: [
        { id: 'a', name: 'Kitchen', floorName: null, note: 'Sink drips.', skipReason: null },
        { id: 'b', name: 'Bedroom 2', floorName: 'Upstairs', note: null, skipReason: 'Tenant asleep' },
      ],
    });
    const notes = within(group('From the technician'));
    const said = (source: string) => notes.getByText(source).closest('div')?.textContent;

    expect(said('Note for the office')).toContain('Return air grille was blocked.');
    expect(said('Pest control')).toContain('Tenant has a newborn.');
    expect(said('Filter 20x25x1 · Hallway')).toContain('Wrong size on the truck');
    expect(said('Kitchen')).toContain('Sink drips.');
    expect(said('Bedroom 2 · Upstairs')).toContain('Skipped: Tenant asleep');
    expect(notes.queryByText('No notes from the technician.')).toBeNull();
  });

  it('says why nobody got in', () => {
    show({ completionBlockedReason: 'Could not get in: Dog in the yard' });
    expect(within(group('From the technician')).getByText('Dog in the yard')).toBeInTheDocument();
  });

  it("does not put the office's own hold on a job in the technician's mouth", () => {
    show({ completionBlockedReason: 'Pending administrator determination.' });
    expect(screen.queryByText('Pending administrator determination.')).toBeNull();
  });

  it("shows the report's closing comments apart, because a tenant and an owner read them", () => {
    show({ nextInspectionAlert: 'Bring a ladder.', maintenanceComments: 'Replace the gutter guard.' });
    const printed = within(group('Printed on the report'));
    expect(printed.getByText('Bring a ladder.')).toBeInTheDocument();
    expect(printed.getByText('Replace the gutter guard.')).toBeInTheDocument();
    expect(within(group('From the technician')).queryByText('Bring a ladder.')).toBeNull();
  });

  it("shows the office's notes as written, with the Edit action beside them", () => {
    show(
      { internalNotes: 'Imported from an Inspect & Cloud PDF report.\nInspector: Pat Example' },
      <button type="button">Edit</button>,
    );
    const office = within(group('From the office'));
    expect(office.getByText(/Imported from an Inspect & Cloud PDF report/)).toBeInTheDocument();
    expect(office.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('offers no Edit to somebody who may not', () => {
    show({ internalNotes: 'Gate code at the office.' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
