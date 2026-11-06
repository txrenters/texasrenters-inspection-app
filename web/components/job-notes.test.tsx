import type { AdminInspection, OfficeNote, VisitServicesReport } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JobNotes } from './job-notes';

/** The job's Notes section. Everything here is invented. */

const access = vi.hoisted(() => ({ permissions: ['inspections:manage'], userId: 'me' }));
const mutations = vi.hoisted(() => ({
  add: { mutate: vi.fn(), isPending: false },
  edit: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ profile: { id: access.userId } }),
  usePermissions: () => ({
    hasAny: (...keys: string[]) => keys.some((key) => access.permissions.includes(key)),
  }),
}));
vi.mock('@/lib/queries', () => ({ useOfficeNoteMutations: () => mutations }));

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

const note = (over: Partial<OfficeNote> = {}): OfficeNote => ({
  id: 'n-1',
  text: 'Owner called about the fence.',
  visibleToTechnician: false,
  createdAt: '2026-11-06T15:00:00.000Z',
  editedAt: null,
  author: { id: 'me', displayName: 'Ada Lane' },
  ...over,
});

function show(over: Partial<AdminInspection> = {}) {
  render(<JobNotes inspection={{ id: 'insp-1', internalNotes: null, ...over } as AdminInspection} />);
}

const group = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  access.permissions = ['inspections:manage'];
  access.userId = 'me';
  mutations.add.mutate.mockReset();
  mutations.edit.mutate.mockReset();
  mutations.remove.mutate.mockReset();
});

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
});

describe('the booking note', () => {
  it('is labelled as what it is, and edited with the job', () => {
    show({ internalNotes: 'Imported from an Inspect & Cloud PDF report.\nInspector: Pat Example' });
    const office = within(group('From the office'));
    expect(office.getByText(/Booking note · on the technician's phone/)).toBeInTheDocument();
    expect(office.getByText(/Imported from an Inspect & Cloud PDF report/)).toBeInTheDocument();
    expect(office.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(office.queryByText('No office notes yet.')).toBeNull();
  });

  it('sits below what the office wrote', () => {
    show({ internalNotes: 'Booked from Propertyware.', officeNotes: [note()] });
    const text = group('From the office').textContent ?? '';
    expect(text.indexOf('Owner called about the fence.')).toBeLessThan(text.indexOf('Booked from Propertyware.'));
  });
});

describe('office notes', () => {
  it('says who wrote a note and when, and marks one the technician can read', () => {
    show({
      officeNotes: [
        note(),
        note({ id: 'n-2', text: 'Use the side gate.', visibleToTechnician: true, author: null }),
      ],
    });
    const office = within(group('From the office'));
    expect(office.getByText(/^Ada Lane · /)).toBeInTheDocument();
    expect(office.getByText(/^Former user · /)).toBeInTheDocument();
    expect(office.getAllByText('Shown to technician')).toHaveLength(1);
  });

  it('says when a note was changed', () => {
    show({ officeNotes: [note({ editedAt: '2026-11-06T16:00:00.000Z' })] });
    expect(screen.getByText(/ · edited /)).toBeInTheDocument();
  });

  it('adds one, private unless ticked', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Call the owner.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(mutations.add.mutate.mock.calls[0]?.[0]).toEqual({ text: 'Call the owner.', visibleToTechnician: false });
  });

  it('shows one to the technician when ticked', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Side gate.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show to technician' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(mutations.add.mutate.mock.calls[0]?.[0]).toEqual({ text: 'Side gate.', visibleToTechnician: true });
  });

  it('will not save a note that is only spaces', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
  });

  it('lets somebody who can review, but not manage, write one', () => {
    access.permissions = ['findings:review'];
    show();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
  });

  it('offers nothing to somebody who can do neither', () => {
    access.permissions = ['inspections:read'];
    show({ officeNotes: [note()] });
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
  });

  it('edits your own note from what it says now', () => {
    show({ officeNotes: [note({ visibleToTechnician: true })] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' });
    expect(box).toHaveValue('Owner called about the fence.');
    expect(screen.getByRole('checkbox', { name: 'Show to technician' })).toBeChecked();
    // Ready to carry on writing: words typed now go after the note, not before it.
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe('Owner called about the fence.'.length);

    fireEvent.change(box, { target: { value: 'Owner called twice.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(mutations.edit.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'n-1',
      text: 'Owner called twice.',
      visibleToTechnician: true,
    });
  });

  it("leaves somebody else's note alone", () => {
    access.userId = 'somebody-else';
    show({ officeNotes: [note()] });
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete note' })).toBeNull();
  });

  it('asks before deleting', () => {
    show({ officeNotes: [note()] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/keeps a record of what it said/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Delete note' }));

    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toBe('n-1');
  });
});
