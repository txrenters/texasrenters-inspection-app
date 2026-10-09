import type { JobberDayRow } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JobberDayActions } from './jobber-day-actions';

/**
 * The buttons beside a difference with Jobber (console-development). The ones
 * that change Jobber change the schedule technicians work from, so they ask
 * first and say they are off when sending to Jobber is switched off.
 */

const held = vi.hoisted(() => ({ permissions: new Set<string>(), mutate: vi.fn() }));

vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => held.permissions.has(key) }) }));
vi.mock('@/lib/queries', () => ({
  useJobberDayAction: () => ({ mutate: held.mutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function row(over: Partial<JobberDayRow> = {}): JobberDayRow {
  return {
    key: 'insp-1',
    inspectionId: 'insp-1',
    jobberVisitId: 'v-1',
    property: '2208 Meadow Gate Dr',
    inspectionType: 'OCCUPIED',
    status: 'SCHEDULED',
    technicianId: 't-1',
    here: { startAt: null, technician: 'Amy W.' },
    jobber: { startAt: null, technician: 'Amy W.', title: 'Occupied Inspection', completed: false },
    state: 'TIME_DIFFERS',
    differences: ['Here 1:00 PM, Jobber 2:30 PM'],
    waitingToSend: false,
    importNote: null,
    ...over,
  };
}

beforeEach(() => {
  held.permissions = new Set(['inspections:manage', 'inspections:assign', 'inspections:finalize']);
  held.mutate.mockReset();
});

describe('actions on a difference with Jobber', () => {
  it('offers to send ours or take Jobber\'s when the time differs', () => {
    render(<JobberDayActions pushesEnabled row={row()} />);

    expect(screen.getByRole('button', { name: 'Send ours to Jobber' })).toBeEnabled();
    expect(screen.getByRole('button', { name: "Take Jobber's" })).toBeEnabled();
  });

  it('shows the Jobber-writing action disabled, with the reason, while pushes are off', () => {
    render(<JobberDayActions pushesEnabled={false} row={row()} />);

    const send = screen.getByRole('button', { name: 'Send ours to Jobber' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', expect.stringContaining('switched off'));
    // Reading Jobber again changes the console only, so it stays available.
    expect(screen.getByRole('button', { name: "Take Jobber's" })).toBeEnabled();
  });

  it('asks first, says what will change, and only then sends', () => {
    render(<JobberDayActions pushesEnabled row={row({ state: 'CANCELLED_HERE', status: 'CANCELLED' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel in Jobber' }));
    expect(held.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('will be removed, as it was cancelled here');

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel in Jobber' }).at(-1)!);
    expect(held.mutate).toHaveBeenCalledWith(
      { action: 'cancel-in-jobber', inspectionId: 'insp-1' },
      expect.anything(),
    );
  });

  it('keeps each action behind its permission', () => {
    held.permissions = new Set(['inspections:manage']);
    const { rerender } = render(
      <JobberDayActions pushesEnabled row={row({ state: 'TECHNICIAN_DIFFERS', differences: ['Jobber has Moses R., here Amy W.'] })} />,
    );
    // Sending the technician needs Assign.
    expect(screen.queryByRole('button', { name: 'Send our technician' })).toBeNull();

    rerender(<JobberDayActions pushesEnabled row={row({ state: 'DONE_HERE', status: 'TECHNICIAN_SUBMITTED' })} />);
    // Completing in Jobber needs Finalize.
    expect(screen.queryByRole('button', { name: 'Complete in Jobber' })).toBeNull();
  });

  it('offers to create the inspection for a visit only Jobber has', () => {
    render(
      <JobberDayActions
        pushesEnabled={false}
        row={row({ state: 'ONLY_IN_JOBBER', inspectionId: null, status: null, here: null, jobberVisitId: 'v-9' })}
      />,
    );

    // Creating here does not write to Jobber, so pushes being off does not matter.
    expect(screen.getByRole('button', { name: 'Create inspection' })).toBeEnabled();
  });

  it('offers nothing where the two agree, or where only a person can decide', () => {
    const { container, rerender } = render(<JobberDayActions pushesEnabled row={row({ state: 'MATCHES', differences: [] })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<JobberDayActions pushesEnabled row={row({ state: 'NOT_IN_JOBBER', jobberVisitId: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
