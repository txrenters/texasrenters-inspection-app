import type { AdminInspection } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectionEditDialog } from './inspection-actions-dialogs';

/**
 * A Jobber visit's date is Jobber's.
 *
 * The sync puts Jobber's date back on its next pass, so the form used to accept
 * a date that quietly reverted two minutes later: one property's
 * move-in, re-dated to the report it held and restored to the next tenant's
 * visit. The API refuses that now, and the form says where to go instead of
 * offering it.
 */

const mutations = vi.hoisted(() => ({
  updateInspection: { mutateAsync: vi.fn(), isPending: false, error: null as Error | null },
  updateJobberVisit: { mutateAsync: vi.fn(), isPending: false, error: null as Error | null },
}));

vi.mock('@/lib/queries', () => ({ useAdminMutations: () => mutations }));

beforeEach(() => {
  mutations.updateInspection.mutateAsync.mockReset().mockResolvedValue({});
  mutations.updateJobberVisit.mutateAsync.mockReset().mockResolvedValue({});
  mutations.updateInspection.error = null;
  mutations.updateJobberVisit.error = null;
});

const inspection = (overrides: Partial<AdminInspection> = {}): AdminInspection => ({
  id: 'inspection-1',
  status: 'SCHEDULED',
  inspectionType: 'MOVE_IN',
  priority: 'STANDARD',
  scheduledAt: '2026-10-02T00:00:00.000Z',
  createdAt: '2026-09-01T21:43:19.000Z',
  updatedAt: '2026-09-14T18:45:58.000Z',
  internalNotes: null,
  assignments: [],
  ...overrides,
});

describe('the one edit for a job', () => {
  const inJobber = {
    scheduledInJobber: true,
    jobberEditsPushed: true,
    jobberVisitTitle: 'Q4 visit',
    jobberVisitDetails: 'Filter Change: 20x25x1',
  };
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  it('offers the visit where it can be changed, and says where it goes', () => {
    render(<InspectionEditDialog inspection={inspection(inJobber)} onClose={() => {}} />);
    expect(screen.getByLabelText('Visit title')).toHaveValue('Q4 visit');
    expect(screen.getByLabelText('Details')).toHaveValue('Filter Change: 20x25x1');
    expect(screen.getByText(/sent to the visit in Jobber/)).toBeTruthy();
  });

  it('leaves it out where it cannot', () => {
    render(<InspectionEditDialog inspection={inspection({ scheduledInJobber: true })} onClose={() => {}} />);
    expect(screen.queryByLabelText('Visit title')).toBeNull();
    expect(screen.getByLabelText('Booking note')).toBeTruthy();
  });

  it('sends Jobber nothing when the visit was not changed', async () => {
    const onClose = vi.fn();
    render(<InspectionEditDialog inspection={inspection(inJobber)} onClose={onClose} />);
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutations.updateInspection.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutations.updateJobberVisit.mutateAsync).not.toHaveBeenCalled();
  });

  it('saves the job, then the visit, when both changed', async () => {
    const onClose = vi.fn();
    render(<InspectionEditDialog inspection={inspection(inJobber)} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'Filter Change: 16x25x1' } });
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutations.updateJobberVisit.mutateAsync).toHaveBeenCalledWith({
      id: 'inspection-1',
      title: 'Q4 visit',
      details: 'Filter Change: 16x25x1',
    });
  });

  it('stays open when Jobber refuses, so nothing typed is lost', async () => {
    const onClose = vi.fn();
    mutations.updateJobberVisit.mutateAsync.mockRejectedValue(new Error('Refused'));
    render(<InspectionEditDialog inspection={inspection(inJobber)} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Visit title'), { target: { value: 'Q4 visit, moved' } });
    save();
    await waitFor(() => expect(mutations.updateJobberVisit.mutateAsync).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows why the visit was refused', () => {
    mutations.updateJobberVisit.error = new Error('Jobber refused the change.');
    render(<InspectionEditDialog inspection={inspection(inJobber)} onClose={() => {}} />);
    expect(screen.getByText('Jobber refused the change.')).toBeTruthy();
  });
});

describe('the scheduled date in the edit form', () => {
  it('is locked on a Jobber visit, with where to change it', () => {
    render(<InspectionEditDialog inspection={inspection({ scheduledInJobber: true })} onClose={() => {}} />);

    expect((screen.getByLabelText('Scheduled date') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/scheduled in jobber\. change the date there/i)).toBeTruthy();
  });

  it('opens on a Jobber visit when the console sends its changes to Jobber', () => {
    render(
      <InspectionEditDialog
        inspection={inspection({ scheduledInJobber: true, jobberEditsPushed: true })}
        onClose={() => {}}
      />,
    );

    expect((screen.getByLabelText('Scheduled date') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/moves the jobber visit to it too/i)).toBeTruthy();
  });

  it('stays editable on an inspection scheduled here', () => {
    render(<InspectionEditDialog inspection={inspection({ scheduledInJobber: false })} onClose={() => {}} />);

    expect((screen.getByLabelText('Scheduled date') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/controls when this inspection appears/i)).toBeTruthy();
  });
});
